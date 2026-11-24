// Plain patterns with no zod dependency, so the extension's content script can
// import them without bundling the whole schema.

/** One path segment for library/<site>/<slug>/. Starts with a letter or digit, so "." and ".." can never match. */
export const PATH_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
