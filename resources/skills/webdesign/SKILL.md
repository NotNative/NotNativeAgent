---
id: webdesign
version: 2
description: Apply a product-aware design standard and validate rendered web interfaces for hierarchy, usability, accessibility, responsiveness, and failure states
invocation: both
requires_tools: [fs.read_text, fs.write_text, fs.edit_text]
---
# Web Design and Validation

Use this skill as a design standard inside the current UI task. It is not a separate
development pipeline, does not imply sub-agent orchestration, and does not replace the
repository's normal planning or implementation process.

The target product's established visual language is authoritative. Improve it deliberately;
do not replace it with a generic house style merely because this skill was loaded.

## 1. Establish the design context

Before changing code:

1. Read the repository guidance, relevant routes, components, styles, tokens, and tests.
2. Identify the users, primary tasks, information hierarchy, supported platforms, and
   accessibility constraints.
3. Find the existing design system or infer its repeated rules from working screens.
4. Preserve behavior, terminology, navigation, and recognizable brand characteristics
   unless the request explicitly changes them.
5. State any important assumption that cannot be established from evidence.

Do not redesign a working interface simply to demonstrate design activity. Every material
change should improve comprehension, task completion, consistency, accessibility, or
resilience.

## 2. Use a Swiss-informed baseline when needed

When the product has no coherent system, use these principles as a restrained baseline:

- Build on an explicit grid and align related elements precisely.
- Let typography, spacing, scale, and position establish hierarchy before decoration.
- Treat whitespace as structure rather than unused area.
- Keep content and task flow primary; remove visual elements without a clear purpose.
- Use a small, consistent type scale and a limited set of font weights.
- Use color sparingly and semantically for emphasis, state, and identity.
- Keep geometry, borders, radii, and spacing systematic.
- Prefer clear labels and objective information architecture over clever presentation.
- Use asymmetry only when it improves hierarchy or movement through the page.

Swiss-informed does not mean making every product resemble a poster, using one universal
typeface, or erasing an existing brand. It is a discipline for clarity and consistency, not
a compulsory aesthetic.

## 3. Avoid generic AI styling

Do not default to:

- glassmorphism, mesh gradients, glowing surfaces, or decorative blur;
- oversized hero copy that displaces useful content;
- excessive pills, badges, rounded cards, floating containers, or card-within-card layouts;
- gradients, shadows, or animation without a functional rationale;
- arbitrary iconography, fake metrics, invented testimonials, or placeholder claims;
- a dashboard layout merely because the page contains several facts;
- ornamental micro-interactions that compete with the task;
- a new visual framework when the project already has usable components and tokens.

Decorative techniques are allowed when they are consistent with the product and serve a
specific purpose. They are not evidence of quality by themselves.

## 4. Design the complete interaction

Account for the full lifecycle, not only the ideal screenshot:

- initial, loading, empty, populated, partial, stale, and offline states;
- validation, permission, recoverable error, fatal error, and retry states;
- disabled, hover, focus, pressed, selected, and completed states;
- long labels, long data, localization growth, missing images, and narrow containers;
- cancellation, undo, confirmation, and safe recovery where the action warrants them.

Make ownership clear: one component should own each state transition, and the visible UI
must agree with the underlying operation. Avoid hidden actions, ambiguous icons, silent
failures, and controls whose outcome is only apparent elsewhere.

## 5. Accessibility is a design constraint

- Use semantic HTML and native controls before recreating them with generic elements.
- Give controls persistent, understandable names and correctly associated labels.
- Preserve logical keyboard order and visible focus indication.
- Ensure all functionality works without a pointing device.
- Do not use color alone to convey status or meaning.
- Verify text and meaningful graphics meet the project's required contrast level, at least
  WCAG AA when no stronger requirement exists.
- Provide useful alternative text; mark purely decorative images as decorative.
- Announce asynchronous status and errors appropriately without creating noisy output.
- Respect reduced-motion and other relevant user preferences.
- Provide practical touch targets, normally at least 44 by 44 CSS pixels on touch layouts.

ARIA supplements correct semantics; it does not repair unsuitable structure.

## 6. Implement within the product

- Reuse existing components, tokens, conventions, and dependencies where they are sound.
- Introduce the smallest coherent set of new primitives needed for the requested result.
- Keep spacing, typography, colors, borders, radii, elevation, and motion tokenized or
  otherwise consistently defined.
- Prefer resilient Grid and Flexbox layouts over brittle absolute positioning.
- Avoid unnecessary dependencies, deep selector chains, and `!important` overrides.
- Reserve image and dynamic-content dimensions to prevent layout shift.
- Keep motion brief, interruptible, and nonessential to understanding.
- Do not change frameworks or replace the design system without explicit authorization.

Responsive behavior follows content and product needs rather than fashionable breakpoint
lists. At minimum, examine a narrow phone-sized viewport, a tablet-sized viewport, and a
wide desktop viewport unless the product explicitly supports a different range.

## 7. Validate with rendered evidence

Source inspection cannot establish that an interface looks or behaves correctly. When a
browser, screenshot, preview, or equivalent rendering tool is available:

1. Render the affected interface at representative narrow, medium, and wide sizes.
2. Exercise the primary task and material state transitions.
3. Inspect keyboard navigation, focus visibility, overflow, clipping, wrapping, contrast,
   loading, empty, and error states.
4. Check the browser console and network failures relevant to the changed flow.
5. Compare the rendered result with the existing product language and the stated goal.
6. Correct defects and render again until the evidence supports completion.

Also run the repository's relevant tests, linting, type checks, and accessibility checks.
Do not claim visual validation from source inspection alone. If rendering or interaction
tools are unavailable, say exactly what remains unverified and provide a focused manual
checklist instead of pretending the visual result was confirmed.

## 8. Completion criteria

Finish only when:

- the requested user outcome is present and existing behavior remains intact;
- the result belongs visually to the target product;
- hierarchy, alignment, typography, spacing, and interaction patterns are coherent;
- important lifecycle and failure states are intentional;
- keyboard, focus, semantics, contrast, motion, and touch behavior are acceptable;
- representative responsive layouts have been rendered and inspected when possible;
- relevant automated checks pass; and
- any unverified behavior or deliberate deviation is reported plainly.
