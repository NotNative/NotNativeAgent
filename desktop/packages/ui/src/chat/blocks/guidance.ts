// SPDX-License-Identifier: Apache-2.0
/**
 * Block kit guidance (docs/planning/desktop-ui-visual-system.md §6.6).
 *
 * What a model reads about drawing a block, built from the catalog so the
 * signatures it writes against are the ones the parser checks. Every session
 * pays for this text, so it says each thing once: the child lists and the tone
 * values are named once instead of in every signature, and a component carries
 * a description only where its signature leaves the agent guessing.
 *
 * `blockGuidance()` is the text the runtime hands the model as part of its
 * session knowledge; it is a public export so the prompt builder reads the
 * same words this module generates.
 */
import { COMPONENTS, ROOT_COMPONENT, signatureOf } from './catalog.ts';

/** Examples a model reads. Each must stay a valid block. */
export const EXAMPLES = [
  ['root = Stack([note, flow])',
    'note = Callout("Retrying is safe; the request never reached the provider.", "info")',
    'flow = Steps([{title: "Prepare", status: "done"}, {title: "Send", status: "current"}, {title: "Confirm"}], "row")'],
  ['root = Stack([card])',
    'card = Card("Deploy", [Row([Stat("Instances", 3), Stat("Errors", 0, "-2", "success")]), Progress("Rollout", 66, 100)])'],
  ['root = Stack([pick])',
    'pick = Choice("direction", [{label: "Smaller slices", description: "Less risk per commit"}, {label: "One large slice"}], "How should I proceed?")'],
] as const;

const TONES = '"neutral" | "info" | "success" | "warning" | "error"';

/**
 * The text a model reads. It names the grammar, the one root rule, the tone
 * values, and every signature, and states the answer behaviour once.
 */
export function blockGuidance(): string {
  const lines: string[] = [];
  lines.push('Draw a block in a fenced ```openui-lang fence to show data, comparisons, flows, progress, or a question to the user.');
  lines.push('');
  lines.push('Grammar: one statement per line, `name = Component(args)`, and the block needs a statement named `root` that is a Stack. A list of names refers to other statements; a call may also be written inline inside a list. Statements that are never used are errors.');
  lines.push('');
  lines.push(`Tone: ${TONES}. A tone is a meaning you state, never a colour: info for a note, success for a completed outcome, warning for something the reader should watch, error for something that failed.`);
  lines.push('');
  lines.push('Components (optional arguments end with `?`; `Item[]` means a list of components or names):');
  for (const component of COMPONENTS) {
    const description = component.description ? ` — ${component.description}` : '';
    lines.push(`- ${signatureOf(component)}${description}`);
  }
  lines.push('');
  lines.push('Rules: put prose in Text with inline Markdown; keep a chart to its labels, one value per label, and null where there is no value; use a Choice, Input, or Slider only when you need the reader to decide something, and give each one a name. A block with a choice freezes once answered and shows the answer.');
  lines.push('');
  lines.push('Examples:');
  for (const example of EXAMPLES) {
    lines.push('```openui-lang');
    for (const line of example) lines.push(line);
    lines.push('```');
  }
  return lines.join('\n');
}

export { ROOT_COMPONENT };
