export function channelOf(version) {
  return /-(?:lime|lemon)[.\d]*$/.test(version) ? "lime" : "stable";
}
