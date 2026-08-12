// Just enough XML for RSS and Atom.
//
// A real parser would be the right call for arbitrary XML. Feeds are not arbitrary:
// they are a flat list of <item> or <entry> elements with a handful of known children,
// and pulling those out with regexes keeps the project dependency-free. If a feed ever
// nests an <item> inside an <item>, this will get it wrong — and that is the deal.

const CDATA = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/;

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'",
};

export function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, code) => {
    if (ENTITIES[code]) return ENTITIES[code];
    if (code.startsWith("#x") || code.startsWith("#X")) {
      return String.fromCodePoint(parseInt(code.slice(2), 16));
    }
    if (code.startsWith("#")) return String.fromCodePoint(Number(code.slice(1)));
    return match;
  });
}

/**
 * Plain text from a fragment.
 *
 * Entities are decoded before tags are stripped, because feeds routinely ship escaped
 * markup (`&lt;p&gt;`) as the body — strip first and you keep the tags as literal text.
 * Decoding again afterwards catches the doubly-escaped ones.
 */
export function textOf(fragment = "") {
  const unwrapped = fragment.match(CDATA)?.[1] ?? fragment;
  return decodeEntities(decodeEntities(unwrapped).replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** Every occurrence of a child element's inner content, in document order. */
export function childrenOf(xml, tag) {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi");
  return [...xml.matchAll(pattern)].map((match) => match[1]);
}

export function firstChild(xml, ...tags) {
  for (const tag of tags) {
    const found = childrenOf(xml, tag)[0];
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Attribute value from the first matching self-closing or open tag, e.g. <link href="..."> */
export function attributeOf(xml, tag, attribute) {
  const pattern = new RegExp(`<${tag}\\b[^>]*\\b${attribute}=["']([^"']+)["']`, "i");
  return xml.match(pattern)?.[1];
}

/** Split a feed document into its <item> (RSS) or <entry> (Atom) fragments. */
export function feedEntries(xml) {
  const items = childrenOf(xml, "item");
  return items.length > 0 ? items : childrenOf(xml, "entry");
}
