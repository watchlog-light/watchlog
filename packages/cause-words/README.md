# @watchlog/cause-words

The English of probable cause that the dashboard (`web/`) and the backend's notifications both say
(ADR-157): the headline templates (`causes.headline.<code>`), the formatting of the facts they hold
(bytes, cores, durations) and a renderer for the part of vue-i18n's message format they use.

- `headlines.js`: the templates. The dashboard merges them into its `en.json` messages; the
  backend renders the notifications' "Likely cause:" line from them.
- `index.js`: `causeValues()`, `renderTemplate()`, `headlineText()`.

Plain JavaScript without dependencies, so the backend image runs it without a build step.
`web/test/cause-words.test.ts` checks that `headlineText()` and vue-i18n give the same sentence
for every headline.
