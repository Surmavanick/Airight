# Aright website

Static marketing website for Aright, aligned with the company pitch deck and official wordmark.

## Run locally

From the project folder:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Project structure

- `index.html` — page content and structure
- `css/styles.css` — brand system, layout, animation, and responsive styles
- `js/main.js` — navigation, scroll reveals, product tabs, counters, and contact form
- `assets/img/` — brand and photography assets
- `Airight.pdf` — source presentation used for brand alignment

## Contact form

Set `CONTACT_EMAIL` near the top of `js/main.js` before publishing if requests should open a pre-addressed email draft.
