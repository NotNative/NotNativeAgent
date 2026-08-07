---
id: webdesign
version: 1
description: Apply modern, polished UI/UX design to any web interface using current CSS techniques, accessibility standards, and responsive patterns
invocation: both
requires_tools: [fs.read_text, fs.write_text, fs.edit_text]
---
# Modern Web Design

Transform any web interface into a modern, polished experience. This skill applies contemporary UI patterns while maintaining performance, accessibility, and maintainability. Use it to elevate the visual quality of existing HTML/CSS/JS projects or guide new frontend work.

## 1. Analyze the Target Interface

Read existing files to understand:
- Current layout structure and component hierarchy
- Existing color scheme, typography, and spacing patterns
- Responsive breakpoints and mobile considerations
- Accessibility features (ARIA labels, semantic HTML, contrast ratios)
- Animation and interaction patterns
- Framework or library in use (vanilla CSS, Tailwind, Bootstrap, etc.)

## 2. Apply Modern Design Principles

### Visual Design Trends (2024-2025)

**Glassmorphism & Layered Depth**
Use `backdrop-filter: blur()` with semi-transparent backgrounds to create frosted-glass surfaces that add depth without visual clutter. Best applied sparingly on cards, navigation bars, or modals over colorful backgrounds.

**Subtle Gradients & Mesh Backgrounds**
Replace flat colors with soft, organic gradients using CSS custom properties. Multi-stop linear and radial gradients create more engaging visuals than solid fills.

**Soft Shadows & Realistic Elevation**
Layer multiple `box-shadow` values for realistic depth instead of harsh single shadows. Use increasing shadow intensity to communicate hierarchy (sm < md < lg).

**Micro-interactions**
Add subtle hover/focus transitions (150-300ms ease-out) to buttons, cards, links, and interactive elements. Small transforms (`translateY(-2px)`), color shifts, or shadow changes make interfaces feel alive without being distracting.

**Rounded Corners & Soft Geometry**
Use consistent border-radius values: 8-16px for cards/containers, pill shapes (50% radius) for buttons and badges. Avoid sharp corners unless the design calls for brutalist aesthetics.

### Typography & Spacing

**Variable Fonts**: Leverage font-weight axis for fluid typography scaling across breakpoints.

**Type Scale**: Establish clear hierarchy with a consistent modular ratio (1.25-1.375). Limit to 2-3 font families maximum.

**Whitespace Grid**: Use an 8px/4px spacing system. Increase padding and margins between elements for breathing room — modern design favors generous whitespace over cramped layouts.

**Container Queries**: Prefer `@container` over media queries where possible for component-level responsiveness that adapts to available space regardless of viewport size.

### Color & Theming

**CSS Custom Properties**: Define all colors, spacing, and radii as design tokens in `:root`. This enables easy theming and consistent updates.

**Dark Mode Support**: Implement `prefers-color-scheme` with smooth transitions between light and dark palettes. Test both modes for contrast compliance.

**Color Contrast**: Ensure WCAG AA compliance minimum (4.5:1 for normal text, 3:1 for large text). Use tools or calculated ratios to verify.

**Semantic Color Variables**: Name colors by purpose (`--color-primary`, `--color-success`, `--color-error`) rather than hue (`--blue-500`).

### Layout & Components

**CSS Grid & Flexbox**: Prefer modern layout modules over floats, inline-block hacks, or absolute positioning where practical.

**Card-Based Design**: Group related content in cards with consistent padding, subtle shadows, and rounded corners. Cards communicate hierarchy better than flat sections.

**Navigation Patterns**: Implement sticky headers for easy access, hamburger menus for mobile, and clear visual indicators for the current section/page.

**Form UX**: Use floating labels or clearly associated static labels, inline validation feedback, accessible error messaging with icons, and logical tab order.

## 3. Implementation Guidelines

### CSS Architecture Pattern

```css
/* === Design Tokens === */
:root {
  /* Colors */
  --color-primary: #6366f1;
  --color-secondary: #8b5cf6;
  --color-accent: #06b6d4;
  --color-background: #ffffff;
  --color-surface: #f8fafc;
  --color-text: #0f172a;
  --color-text-muted: #64748b;
  --color-border: #e2e8f0;

  /* Radii */
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;
  --radius-full: 9999px;

  /* Shadows */
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.05);
  --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.1),
               0 2px 4px -2px rgba(0, 0, 0, 0.1);
  --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.1),
               0 4px 6px -4px rgba(0, 0, 0, 0.1);

  /* Transitions */
  --transition-fast: 150ms ease-out;
  --transition-normal: 250ms ease-out;
}

/* Dark mode */
@media (prefers-color-scheme: dark) {
  :root {
    --color-background: #0f172a;
    --color-surface: #1e293b;
    --color-text: #f8fafc;
    --color-text-muted: #94a3b8;
    --color-border: #334155;
  }
}

/* Reduced motion */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}

/* === Component Patterns === */

.glass-card {
  background: rgba(255, 255, 255, 0.7);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-md);
}

.btn-primary {
  background: linear-gradient(135deg, var(--color-primary), var(--color-secondary));
  color: white;
  padding: 0.75rem 1.5rem;
  border: none;
  border-radius: var(--radius-full);
  cursor: pointer;
  transition: transform var(--transition-fast), box-shadow var(--transition-fast);
}

.btn-primary:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-lg);
}

.btn-primary:focus-visible {
  outline: 3px solid var(--color-accent);
  outline-offset: 2px;
}
```

### Accessibility Requirements (Non-Negotiable)

- All interactive elements must have visible focus states (`outline` or `box-shadow`)
- Images require descriptive `alt` text (decorative images use `alt=""`)
- Forms need proper `<label>` associations and accessible error messaging
- Color alone cannot convey information — pair with icons, text, or patterns
- Keyboard navigation must work for all interactive elements in logical tab order
- Use semantic HTML5 elements (`<header>`, `<nav>`, `<main>`, `<section>`, `<article>`)
- Respect `prefers-reduced-motion` by disabling non-essential animations
- Ensure touch targets are at least 44x44px on mobile

### Performance Considerations

- Minimize CSS specificity; avoid `!important` and deep nesting chains
- Use `will-change` sparingly only for animations that genuinely need GPU acceleration
- Prefer CSS transforms (`translate`, `scale`) over layout-triggering properties (`top`, `left`, `width`)
- Lazy load images with `loading="lazy"` attribute
- Keep total CSS under 150KB uncompressed when possible; extract unused styles

## 4. Responsive Design Strategy

### Breakpoint System (Mobile-First)

```css
/* Base = mobile */
.container { padding: 1rem; }

@media (min-width: 640px) { /* sm - large phones */
  .container { padding: 2rem; }
}

@media (min-width: 768px) { /* md - tablets */
  .container { max-width: 720px; margin: 0 auto; }
}

@media (min-width: 1024px) { /* lg - laptops */
  .container { max-width: 960px; }
}

@media (min-width: 1280px) { /* xl - desktops */
  .container { max-width: 1140px; }
}
```

### Container Queries for Components

```css
.card-container { container-type: inline-size; }

@container (max-width: 400px) {
  .card-content { flex-direction: column; }
}
```

## 5. Review Checklist

Before completing any design work, verify every item:

- [ ] Color contrast meets WCAG AA standards for all text and interactive elements
- [ ] All interactive elements have visible hover AND focus states
- [ ] Layout works on mobile (320px), tablet (768px), and desktop (1440px+)
- [ ] Dark mode is supported with proper contrast in both modes
- [ ] Animations respect `prefers-reduced-motion` media query
- [ ] No inline styles that should be CSS classes or custom properties
- [ ] Semantic HTML structure is maintained throughout
- [ ] Images have appropriate alt text and loading attributes
- [ ] Forms are accessible with proper labels, error states, and tab order
- [ ] CSS custom properties are used consistently for theming
- [ ] Touch targets meet minimum 44x44px on mobile viewports
- [ ] No layout shift (CLS) from lazy-loaded content or dynamic elements

## 6. Workflow

When applying this skill:

1. **Read** existing files to understand current state and constraints
2. **Propose** specific design improvements with rationale tied to the checklist above
3. **Implement** changes using modern CSS techniques, preserving all existing functionality
4. **Verify** accessibility requirements are met across light/dark modes
5. **Test** responsive behavior conceptually across key breakpoints
6. **Document** any new design tokens or patterns introduced

Preserve existing functionality while elevating visual quality and user experience. Never break working features in pursuit of aesthetics. When the project uses a CSS framework (Tailwind, Bootstrap, etc.), work within its conventions rather than introducing conflicting custom styles unless explicitly requested.
