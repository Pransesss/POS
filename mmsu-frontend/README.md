# MMSU Auxiliary POS — Frontend starter (HTML + CSS only)

Every screen is already laid out. Only the *data* parts are empty (numbers show `—`, tables show "No data yet",
charts are dashed boxes). Nothing needs JavaScript to preview: tabs, segmented buttons and payment switches work with CSS only.

**Preview:** open `login.html` in a browser (it has shortcut links), or use VS Code "Live Server".

## Folders
```
login.html            sign-in page
components.html       every reusable piece (buttons, badges, dots, banners, 3 modals) — copy from here
css/
  base.css            colors (CSS variables), reset, forms, buttons, utilities
  layout.css          app shell, sidebar, page header, page grids, login (sidebar + login match the Figma)
  icons.css           sidebar icons (CSS masks). Add class nav-item--<name> to a link; edit the SVG path to change an icon
  components.css      card, kpi, table, badge, dot, tabs, segmented, tiles, banner, chips, modal
  pages.css           POS meal builder, current-sale panel, receiving, report slips
  print.css           only the report slips are printed
staff/                dashboard, pos, pos-meal, pos-meat, receiving, inventory, transactions
admin/                dashboard, deliveries, inventory, transactions, events, settings
logos/mamasu.png     MMSU seal used by login + sidebar (add logos/college.png and swap the placeholder in the sidebar footer)
js/common.js         writes TODAY's date in the headers/date filters + Online/Offline badge (no backend needed)
js/api.js             the ONLY file that knows where data comes from (mock JSON now, Flask API later)
mock/forecast.json    example of the JSON the API will return (contract)
```

## Matches the Figma
Sidebar (flush top-left, full-width glowing active bar), login, dashboard cards, POS tiles, meal builder and Current Sale card follow the Figma frames. Colors/fonts live in `css/base.css` (`--bg`, `--panel`, `--green`, `--font-sans`, `--font-serif`).

## Rules so the team stays consistent
1. **Hooks:** every spot JS must fill has an `id` (`kpi-predicted`, `table-predicted`, `cash-total` ...). Do not rename an id without telling the backend/JS owner.
2. **Prices** are written as `data-price="beef"` etc. They must come from the API (`meal_price` table). Never type a price in the HTML.
3. **Naming:** BEM-style classes (`order__line`, `card__head`), kebab-case ids, 2-space indentation, no inline styles (two exceptions in deliveries.html to clean up).
4. **Colors:** only the variables in `base.css`. Blue dot = budget meal, orange dot = take-out. No other transaction labels.
5. `[hidden]` elements (banners, results list) are meant to be shown by JS. Remove the attribute temporarily to preview them.
6. The sidebar is copy-pasted on each page (only `.is-active` moves). When Flask is added, backend turns it into one Jinja partial.

## Your task order
1. Open every page, compare with the Figma, fix spacing / colors (CSS only).
2. Make the pages responsive (check 1024px and phone width).
3. Add the missing screen states: loading, empty, error (see `components.html` for the style).
4. Fill containers from `mock/*.json` using `api()` in `js/api.js` (start with the dashboard).
5. POS logic: price calculation (client-side preview only — the server recomputes), cart, Dine in/Take out, e-wallet 4-digit check.
6. Forms: validation messages (login, delivery, account settings).
7. Switch `USE_MOCK = false` when the backend endpoint is ready; fix any difference from the contract with the backend dev.

---
## Connected to the backend
`js/common.js` (date/time, sign-in guard, sidebar), `js/api.js` (the only file that calls the API), `js/offline.js` (offline outbox + sync)
and one script per page now exist. The HTML/CSS design is unchanged (only addition: the Auxiliaries card in Settings).
Run it through Flask (`python backend/app.py`) and open http://localhost:5000. See `docs/SETUP.md`.
