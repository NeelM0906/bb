/**
 * BB's plugin gallery intake form (GitHub URL, name, description, why it's
 * useful, email). The form is the entire submission UI for now — bb only links
 * out to it, so there is no schema, route, or field validation on this side to
 * keep in sync with its questions.
 *
 * A module constant rather than a setting: this is BB's own form, not anything
 * a user configures, so there is no knob to document in the CLI guide.
 */
export const PLUGIN_SUBMISSION_FORM_URL =
  "https://docs.google.com/forms/d/e/1FAIpQLScRTABhHwCjuZWYn0lJJd0aZT2cYvGk2KaZ2GF-1GsXoLMLSQ/viewform";
