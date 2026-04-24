import type { VNode } from 'preact';

export interface EmailPreviewProps {
  html: string;
  title?: string;
  className?: string;
}

export function EmailPreview(props: EmailPreviewProps): VNode {
  const title = props.title ?? 'Email preview';
  const wrapperClass = props.className
    ? `email-preview-wrapper ${props.className}`
    : 'email-preview-wrapper';
  return (
    <div class={wrapperClass}>
      {/* Empty sandbox string = drop all capabilities (no scripts, no same-origin, no forms, no top-nav). */}
      <iframe
        class="email-preview-frame"
        title={title}
        sandbox=""
        srcDoc={props.html}
        referrerpolicy="no-referrer"
        loading="lazy"
      />
    </div>
  );
}
