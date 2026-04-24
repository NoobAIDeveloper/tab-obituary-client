// Static fixture used by the preview route.
// Body text is lifted verbatim from PRD §6.3; do not paraphrase.

export const SAMPLE_EMAIL_SUBJECT = 'Last week, you fell down a hole about Peter Attia.';

export const SAMPLE_EMAIL_PREHEADER =
  'Also, you are apparently still thinking about that apartment.';

export const SAMPLE_EMAIL_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Last week, you fell down a hole about Peter Attia.</title>
    <style>
      html, body { margin: 0; padding: 0; background: #fff; color: #1b1b1b; }
      body {
        font-family: Georgia, "Iowan Old Style", "Palatino Linotype", serif;
        font-size: 15px;
        line-height: 1.55;
      }
      .container {
        max-width: 560px;
        margin: 0 auto;
        padding: 24px;
      }
      h2 {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.02em;
        margin: 24px 0 8px;
        text-transform: none;
      }
      h2:first-of-type { margin-top: 0; }
      p { margin: 0 0 12px; }
      .preheader {
        color: #8a8a8a;
        font-style: italic;
        font-size: 13px;
        margin-bottom: 20px;
      }
      ul.plain {
        list-style: none;
        padding: 0;
        margin: 0 0 12px;
      }
      ul.plain li { margin: 0 0 6px; }
      .quote {
        font-style: italic;
        margin: 0 0 8px;
      }
      .signoff {
        margin-top: 24px;
        font-style: italic;
        color: #555;
      }
      .footer {
        margin-top: 8px;
        font-size: 12px;
        color: #8a8a8a;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <p class="preheader">Also, you are apparently still thinking about that apartment.</p>

      <h2>Your week</h2>
      <p>On Tuesday at 9:47pm, you went down a two-hour spiral on keto diets, autophagy, and Peter Attia. You opened 14 tabs, closed 2, and ended the session at 11:51pm with "does rapamycin actually work" still open in a pinned tab it has not left since.</p>
      <p>On Saturday morning, you did something unusual: you researched a single apartment for 38 minutes. Streetview, school ratings, three different mortgage calculators, and a Reddit thread from 2019 about the neighborhood's trash pickup schedule. We don't know what this means. You probably do.</p>

      <h2>What you kept coming back to</h2>
      <p>youtube.com — 4h 12m across 38 visits. You kept going back, the way you keep going back.</p>
      <p>news.ycombinator.com — 2h 04m across 61 visits. A visit every 23 waking minutes, on average.</p>
      <p>zillow.com — 1h 18m, all on Saturday. See above.</p>

      <h2>What the week was about</h2>
      <ul class="plain">
        <li>– AI tools you will probably not install (22%)</li>
        <li>– Longevity content, which is new (16%)</li>
        <li>– A specific apartment (11%)</li>
        <li>– Actual work (14%)</li>
        <li>– Ambient Wikipedia (9%)</li>
      </ul>

      <h2>Tabs you opened and never really visited</h2>
      <p class="quote">"How to write a cover letter that doesn't suck" — Monday, 2 seconds.</p>
      <p class="quote">"rapamycin dosing protocol reddit" — Tuesday, 4 seconds.</p>
      <p class="quote">"is my cat mad at me" — Thursday, 1 second.</p>
      <p class="quote">"apartment hunting checklist pdf" — Saturday, 3 seconds.</p>

      <h2>Since last week</h2>
      <ul class="plain">
        <li>– Last week was keto. This week is apparently Peter Attia, which is the same thing, with more podcasts.</li>
        <li>– You are down 40% on LinkedIn. We won't comment.</li>
        <li>– Hacker News is back, as it always is.</li>
      </ul>

      <h2>Tabs still alive</h2>
      <p>7 tabs older than 3 days. The oldest is "Attia rapamycin longevity — Huberman", opened 11 days ago. You know what to do. Or don't. It's your tab.</p>

      <p class="signoff">— Tab Obituary</p>
      <p class="footer">Pause tracking · Delete all data · Export · Settings</p>
    </div>
  </body>
</html>`;
