export function channelOf(version) {
  return /-(?:lime|lemon)[.\d]*$/.test(version) ? "lime" : "stable";
}

export function appIconName({ development, channel }) {
  if (development) return "citropy-dev";
  return channel === "lime" ? "citropy-lime" : "citropy";
}
