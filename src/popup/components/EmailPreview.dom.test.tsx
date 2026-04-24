// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { EmailPreview } from './EmailPreview.js';

afterEach(() => cleanup());

const SIMPLE_HTML = '<!doctype html><html><body><p>hi</p></body></html>';

function getIframe(container: HTMLElement): HTMLIFrameElement {
  const iframe = container.querySelector('iframe');
  if (!iframe) throw new Error('iframe not found');
  return iframe as HTMLIFrameElement;
}

function getWrapper(container: HTMLElement): HTMLElement {
  const el = container.querySelector('.email-preview-wrapper');
  if (!el) throw new Error('wrapper not found');
  return el as HTMLElement;
}

describe('EmailPreview', () => {
  it('renders a wrapper with class email-preview-wrapper containing an iframe', () => {
    const { container } = render(<EmailPreview html={SIMPLE_HTML} />);
    const wrapper = getWrapper(container);
    expect(wrapper.querySelector('iframe')).not.toBeNull();
  });

  it('iframe has class email-preview-frame', () => {
    const { container } = render(<EmailPreview html={SIMPLE_HTML} />);
    const iframe = getIframe(container);
    expect(iframe.className).toContain('email-preview-frame');
  });

  it('sandbox attribute is present and set to the empty string', () => {
    const { container } = render(<EmailPreview html={SIMPLE_HTML} />);
    const iframe = getIframe(container);
    // getAttribute returns "" for sandbox=""; contrast with null when absent.
    expect(iframe.hasAttribute('sandbox')).toBe(true);
    expect(iframe.getAttribute('sandbox')).toBe('');
  });

  it('sandbox attribute does NOT contain any allow-* flag', () => {
    const { container } = render(<EmailPreview html={SIMPLE_HTML} />);
    const iframe = getIframe(container);
    const sandboxValue = iframe.getAttribute('sandbox') ?? '';
    expect(sandboxValue.includes('allow-')).toBe(false);
  });

  it('srcDoc attribute reflects the provided html', () => {
    const { container } = render(<EmailPreview html={SIMPLE_HTML} />);
    const iframe = getIframe(container);
    // Preact forwards srcDoc → srcdoc attribute.
    expect(iframe.getAttribute('srcdoc')).toBe(SIMPLE_HTML);
  });

  it('defaults title to "Email preview"', () => {
    const { container } = render(<EmailPreview html={SIMPLE_HTML} />);
    const iframe = getIframe(container);
    expect(iframe.getAttribute('title')).toBe('Email preview');
  });

  it('honors a custom title prop', () => {
    const { container } = render(<EmailPreview html={SIMPLE_HTML} title="Weekly obituary" />);
    const iframe = getIframe(container);
    expect(iframe.getAttribute('title')).toBe('Weekly obituary');
  });

  it('sets referrerpolicy to no-referrer', () => {
    const { container } = render(<EmailPreview html={SIMPLE_HTML} />);
    const iframe = getIframe(container);
    // Attribute casing is normalized to lowercase in HTML.
    expect(iframe.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('sets loading=lazy', () => {
    const { container } = render(<EmailPreview html={SIMPLE_HTML} />);
    const iframe = getIframe(container);
    expect(iframe.getAttribute('loading')).toBe('lazy');
  });

  it('forwards className onto the wrapper (not the iframe)', () => {
    const { container } = render(<EmailPreview html={SIMPLE_HTML} className="extra-layout" />);
    const wrapper = getWrapper(container);
    expect(wrapper.className).toContain('email-preview-wrapper');
    expect(wrapper.className).toContain('extra-layout');
    const iframe = getIframe(container);
    expect(iframe.className).not.toContain('extra-layout');
  });

  it('wrapper className is exactly the base class when no className prop is provided', () => {
    const { container } = render(<EmailPreview html={SIMPLE_HTML} />);
    const wrapper = getWrapper(container);
    expect(wrapper.className).toBe('email-preview-wrapper');
  });

  it('does not render the html as Preact children (srcdoc is the only path)', () => {
    const htmlWithScript =
      '<!doctype html><html><body><script>window.__pwned=true</script><p>x</p></body></html>';
    const { container } = render(<EmailPreview html={htmlWithScript} />);
    // The outer document must not contain a <script> node from the html prop.
    // happy-dom doesn't execute sandboxed iframe content, but even the
    // unsandboxed parent DOM should be clean — the html goes to srcdoc only.
    expect(container.querySelector('script')).toBeNull();
    // Sanity: the iframe still has the html in its srcdoc attribute.
    const iframe = getIframe(container);
    expect(iframe.getAttribute('srcdoc')).toBe(htmlWithScript);
  });

  it('re-rendering with a new html string updates the srcdoc attribute', () => {
    const { container, rerender } = render(<EmailPreview html={SIMPLE_HTML} />);
    rerender(<EmailPreview html="<!doctype html><html><body>b</body></html>" />);
    const iframe = getIframe(container);
    expect(iframe.getAttribute('srcdoc')).toBe('<!doctype html><html><body>b</body></html>');
  });

  it('re-rendering with a new title prop updates the iframe title attribute', () => {
    const { container, rerender } = render(<EmailPreview html={SIMPLE_HTML} title="first" />);
    expect(getIframe(container).getAttribute('title')).toBe('first');
    rerender(<EmailPreview html={SIMPLE_HTML} title="second" />);
    expect(getIframe(container).getAttribute('title')).toBe('second');
  });

  it('sandbox explicitly contains none of the allow-* escape hatches', () => {
    const { container } = render(<EmailPreview html={SIMPLE_HTML} />);
    const iframe = getIframe(container);
    const sandbox = iframe.getAttribute('sandbox') ?? 'MISSING';
    // Enumerate the dangerous tokens we care about; none may appear.
    for (const token of [
      'allow-scripts',
      'allow-same-origin',
      'allow-forms',
      'allow-top-navigation',
      'allow-popups',
      'allow-modals',
      'allow-pointer-lock',
      'allow-presentation',
      'allow-downloads',
    ]) {
      expect(sandbox).not.toContain(token);
    }
    // And the attribute really is literally empty, not some whitespace value.
    expect(sandbox).toBe('');
  });

  it('srcdoc holds the exact html string for a distinctive fixture', () => {
    const distinctive = '<!doctype html><html><body><p>NONCE_abc123</p></body></html>';
    const { container } = render(<EmailPreview html={distinctive} />);
    const iframe = getIframe(container);
    expect(iframe.getAttribute('srcdoc')).toBe(distinctive);
  });

  it('html content is never materialized as Preact children in the wrapper tree', () => {
    const distinctive = '<!doctype html><html><body><p>NONCE_abc123</p></body></html>';
    const { container } = render(<EmailPreview html={distinctive} />);
    const wrapper = getWrapper(container);
    // The load-bearing assertion: the html is only a srcdoc attribute value,
    // not parsed as children into the parent document.
    expect(wrapper.querySelector('p')).toBeNull();
    expect(wrapper.querySelectorAll('p').length).toBe(0);
    expect(wrapper.querySelectorAll('*').length).toBe(1); // exactly one child: the iframe
    expect(wrapper.firstElementChild?.tagName.toLowerCase()).toBe('iframe');
    // happy-dom quirk: Element.innerHTML does NOT entity-escape `<`/`>`/`"`
    // inside attribute values, so `wrapper.innerHTML` will still contain the
    // literal distinctive string even though the DOM tree itself is clean.
    // Real browsers entity-escape attribute values on serialization; this test
    // documents the happy-dom behavior so future readers don't misread it.
    //   expect(wrapper.innerHTML.includes(distinctive)).toBe(false); // fails under happy-dom
  });

  it('renders with html="" without crashing; iframe still exists with empty srcdoc', () => {
    const { container } = render(<EmailPreview html="" />);
    const iframe = getIframe(container);
    // srcdoc should still be present (with empty string), not omitted.
    expect(iframe.hasAttribute('srcdoc')).toBe(true);
    expect(iframe.getAttribute('srcdoc')).toBe('');
    // Sandbox contract holds.
    expect(iframe.getAttribute('sandbox')).toBe('');
  });

  it('handles a 50KB html blob — whole value is preserved in the attribute', () => {
    const big = `<!doctype html><html><body>${'x'.repeat(50_000)}</body></html>`;
    const { container } = render(<EmailPreview html={big} />);
    const iframe = getIframe(container);
    const srcdoc = iframe.getAttribute('srcdoc') ?? '';
    expect(srcdoc.length).toBe(big.length);
    expect(srcdoc).toBe(big);
  });

  it('html with a breakout attempt is preserved verbatim in the srcdoc attribute', () => {
    // If Preact/happy-dom attribute-escaped incorrectly, the `"` would close
    // the srcdoc attribute and `<iframe>`/`<script>` fragments would appear
    // as sibling elements. Assert the full string round-trips and that no
    // second iframe or any script element was injected into the wrapper.
    const evil = '"></iframe><script>window.__pwned=1</script><iframe srcdoc="x">';
    const { container } = render(<EmailPreview html={evil} />);
    const iframe = getIframe(container);
    expect(iframe.getAttribute('srcdoc')).toBe(evil);
    const wrapper = getWrapper(container);
    expect(wrapper.querySelectorAll('iframe').length).toBe(1);
    expect(wrapper.querySelector('script')).toBeNull();
  });

  it('html containing a U+0000 null character still renders; attribute round-trips', () => {
    const withNull = '<!doctype html><html><body> NUL</body></html>';
    const { container } = render(<EmailPreview html={withNull} />);
    const iframe = getIframe(container);
    // happy-dom may or may not preserve the null byte verbatim; what we care
    // about is that the component doesn't throw and the iframe still holds
    // a string that includes the surrounding context.
    expect(iframe).not.toBeNull();
    const srcdoc = iframe.getAttribute('srcdoc') ?? '';
    expect(srcdoc.includes('NUL')).toBe(true);
  });

  it('html containing &, <, >, and quotes is preserved exactly in srcdoc', () => {
    const tricky = `<!doctype html><html><body>amp:& lt:< gt:> quot:" apos:'</body></html>`;
    const { container } = render(<EmailPreview html={tricky} />);
    const iframe = getIframe(container);
    expect(iframe.getAttribute('srcdoc')).toBe(tricky);
  });

  it('wrapper exposes the .email-preview-wrapper CSS hook', () => {
    const { container } = render(<EmailPreview html={SIMPLE_HTML} />);
    const wrapper = container.querySelector('.email-preview-wrapper');
    expect(wrapper).not.toBeNull();
    const iframe = container.querySelector('.email-preview-frame');
    expect(iframe).not.toBeNull();
    expect(iframe?.tagName.toLowerCase()).toBe('iframe');
  });
});
