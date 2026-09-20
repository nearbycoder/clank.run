/* @clankImportSource ../../vendor/dom.js */
import { For } from "../../vendor/dom.js";
import { getKeyboardGuide } from "./keyboard-guide-data.js";

export function KeyboardGuide(props: { slug: string }) {
  const guide = getKeyboardGuide(props.slug);
  if (!guide) return null;
  const headingId = `keyboard-guide-${guide.slug}`;
  return <section class="keyboard-guide" aria-labelledby={headingId}>
    <h2 id={headingId}>Keyboard guidance</h2>
    <p>{guide.note}</p>
    {guide.rows.length ? <>
      <p class="keyboard-guide-scope">{guide.source === "controller" ? "Keys from the Clank controller contract, with preview and configuration notes." : "Keys verified against the controls used in this preview."} Disabled or read-only controls may prevent changes.</p>
      <dl class="keyboard-guide-list"><For each={guide.rows} by="key">{(row) => <div><dt><kbd>{row.key}</kbd></dt><dd>{row.action}{row.when ? <small>{row.when}</small> : null}</dd></div>}</For></dl>
    </> : null}
  </section>;
}
