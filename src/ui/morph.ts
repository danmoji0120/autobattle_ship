// Minimal DOM morphing: update a container to new HTML *in place*.
//
// Panels used to be rebuilt with innerHTML whenever server state changed (credits tick up every
// second while miners sell), which replaced every <select>/<input>: open dropdowns closed, chosen
// options reset to the first one, scroll jumped to the top. morph() keeps every element that is still
// "the same" (same tag and key) and only touches text and attributes that actually changed, so the
// user's in-progress input survives while numbers keep updating live.
//
// Element identity: tag + id, or the first data-* attribute (e.g. data-buyship="cruiser"); elements
// whose key differs are replaced. Form-control state (value, selectedness, checked) is the user's:
// it is never overwritten from the new HTML, only the markup around it.

const keyOf = (el: Element): string => {
  if (el.id) return `${el.tagName}#${el.id}`;
  for (const a of Array.from(el.attributes)) if (a.name.startsWith('data-')) return `${el.tagName}[${a.name}=${a.value}]`;
  return el.tagName;
};

function syncAttrs(a: Element, b: Element) {
  for (const at of Array.from(a.attributes)) if (!b.hasAttribute(at.name)) a.removeAttribute(at.name);
  for (const at of Array.from(b.attributes)) if (a.getAttribute(at.name) !== at.value) a.setAttribute(at.name, at.value);
}

function morphNode(a: Node, b: Node): Node {
  if (a.nodeType !== b.nodeType || (a.nodeType === 1 && keyOf(a as Element) !== keyOf(b as Element))) {
    const n = b.cloneNode(true); a.parentNode!.replaceChild(n, a); return n;
  }
  if (a.nodeType === 3 || a.nodeType === 8) { if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue; return a; }
  const ea = a as Element, eb = b as Element;
  if (ea instanceof HTMLSelectElement) { morphSelect(ea, eb as HTMLSelectElement); return a; }
  syncAttrs(ea, eb);
  morphChildren(ea, eb);
  return a;
}

function morphChildren(a: Node, b: Node) {
  const bs = Array.from(b.childNodes);
  let i = 0;
  for (; i < bs.length; i++) {
    const cur = a.childNodes[i];
    if (!cur) a.appendChild(bs[i].cloneNode(true));
    else morphNode(cur, bs[i]);
  }
  while (a.childNodes.length > bs.length) a.removeChild(a.lastChild!);
}

/** a <select>: keep the user's choice; if it is no longer offered, keep it visibly as unavailable
 *  instead of silently jumping to another option */
function morphSelect(a: HTMLSelectElement, b: HTMLSelectElement) {
  const chosen = a.dataset.touched ? a.value : null;
  const GONE = ' — 더 이상 선택할 수 없음';
  const chosenText = (a.selectedOptions[0]?.text ?? '').replace(GONE, '');
  const same = a.options.length === b.options.length && Array.from(b.options).every((o, i) => a.options[i].value === o.value && a.options[i].text === o.text && a.options[i].disabled === o.disabled);
  for (const at of Array.from(b.attributes)) if (a.getAttribute(at.name) !== at.value) a.setAttribute(at.name, at.value);
  if (same) {
    // options unchanged: leave it alone (an open dropdown stays open); a select the player hasn't
    // chosen in simply follows the server's current value
    if (chosen === null && document.activeElement !== a && a.value !== b.value) a.value = b.value;
    return;
  }
  a.innerHTML = b.innerHTML;
  if (chosen === null) { a.value = b.value; return; }
  if (Array.from(a.options).some(o => o.value === chosen && !o.disabled)) { a.value = chosen; a.classList.remove('gone'); return; }
  const o = document.createElement('option');
  o.value = chosen; o.disabled = true; o.text = (chosenText || '선택 항목') + GONE;
  a.appendChild(o); a.value = chosen; a.classList.add('gone');
}

/** replace `el`'s content with `html`, preserving everything the user is interacting with */
export function morph(el: Element, html: string) {
  const t = document.createElement('template');
  t.innerHTML = html;
  if (!el.firstChild) { el.appendChild(t.content); return; }
  morphChildren(el, t.content);
}

/** form selects (marked data-keep) remember the player's pick across morphs; selects that issue a
 *  command right away just follow the server. Call once per root. */
export function trackSelects(root: Element) {
  if ((root as any)._tracked) return;
  (root as any)._tracked = true;
  root.addEventListener('change', e => { const t = e.target as HTMLElement; if (t instanceof HTMLSelectElement && t.hasAttribute('data-keep')) { t.dataset.touched = '1'; t.classList.remove('gone'); } }, true);
}
