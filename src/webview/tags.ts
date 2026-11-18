// SPDX-License-Identifier: MPL-2.0

import { isTagColor, type TagColors, type TagStyle } from "../shared/tags";

const palette = [
  "#4EB7E8",
  "#7BA8FF",
  "#BB99F1",
  "#E484BB",
  "#EF9271",
  "#DCA83D",
  "#7BBA61",
  "#48BFA9",
  "#BEAE5F",
  "#A697EF",
  "#E77784",
  "#5FABD3",
];

export function tagColor(name: string, colors: TagColors) {
  if (Object.hasOwn(colors, name) && isTagColor(colors[name]))
    return colors[name];
  let hash = 2166136261;
  for (const character of name)
    hash = Math.imul(hash ^ character.codePointAt(0), 16777619);
  return palette[(hash >>> 0) % palette.length];
}

export function renderTags(
  tags: string[],
  colors: TagColors,
  style: TagStyle,
  limit = 24,
) {
  const container = document.createElement("span");
  container.className = `signalTags tagStyle-${style}`;
  container.title = tags.map((tag) => "#" + tag).join(" ");
  if (style === "dot") container.setAttribute("aria-label", container.title);
  for (const tag of tags.slice(0, limit)) {
    const badge = document.createElement("span");
    badge.className = "tagBadge";
    badge.style.setProperty("--tag-color", tagColor(tag, colors));
    badge.textContent = "#" + tag;
    container.append(badge);
  }
  if (tags.length > limit) {
    const count = document.createElement("span");
    count.className = "tagOverflow";
    count.textContent = "+" + (tags.length - limit);
    container.append(count);
  }
  return container;
}
