# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is enabled on this template. See [this documentation](https://react.dev/learn/react-compiler) for more information.

Note: This will impact Vite dev & build performances.

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.

## Responsive design (mobile + tablet)

This app is designed to be **mobile-first** and to work well on tablets.

- **Breakpoints**:
  - **Mobile**: \(<= 720px\)
  - **Tablet**: \(<= 1024px\)
- **Navigation**:
  - On mobile, the sidebar becomes an **off-canvas drawer** opened via the topbar menu button.
- **When adding new UI**:
  - Avoid fixed widths; prefer `max-width`, `minmax(0, 1fr)`, and wrapping layouts.
  - For tables, ensure they can **scroll horizontally** on mobile (use `.tableWrap`).
  - Don’t rely on `:hover` for critical actions on touch devices.
