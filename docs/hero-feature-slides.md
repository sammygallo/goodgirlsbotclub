# Hero Slides: Curation Guide

The big banner at the top of the home page (the page you see before you open a chat), and the **Featured characters** row beneath it, are driven by one file:

```
public/hero/feature-slides.json
```

Editing that file is the whole job. **No code changes are needed** to add, remove, reorder or switch off a slide. This guide is for whoever curates it.

Design reference: `docs/ui-redesign-e6-design-spec.md` (decisions D-H4 to D-H11 and D-H21).

## How a change reaches people

The file is a static asset, baked into the frontend image, so a change goes live with the next frontend deploy. While you are editing, `npm run dev` serves `public/` live: save the file and reload the page.

The service worker fetches `/hero/` from the network, so an edited file shows on the next page load after a deploy.

## The file

```json
{
  "version": 1,
  "slides": [
    { "kind": "character", "avatar": "ivy.png" },
    {
      "id": "selfie-mode",
      "title": "Take a selfie with your character",
      "body": "One or two plain sentences, 160 characters or fewer.",
      "image": "/hero/selfie-mode.webp",
      "cta": {
        "label": "Learn more",
        "modal": {
          "kind": "feature",
          "heading": "Selfie mode",
          "image": "/hero/selfie-mode.webp",
          "bodyMarkdown": "Ask for a selfie in chat and your character sends one.\n\n- Works with any avatar you generated\n- Costs nothing extra"
        }
      }
    },
    { "kind": "character", "avatar": "rose.png", "requires": "character:create" }
  ]
}
```

`version` must be `1`. A file with any other version is ignored whole (no slides at all), because a newer file's entries may not mean what this build thinks they mean.

### Two kinds of entry

An entry is a **featured character** (`"kind": "character"`) or a **feature / announcement** (no `kind`, or `"kind": "feature"`).

**Featured character** — the character card supplies everything you see (name, art, creator, and the first sentence of its creator notes), so the entry only names it:

| Field | Required | Meaning |
| --- | --- | --- |
| `kind` | yes | `"character"` |
| `avatar` | yes | The character's avatar file name, e.g. `"ivy.png"` |
| `id` | no | A label for your own reference |
| `enabled` | no | `false` switches it off without deleting it. Default `true` |
| `requires` | no | A permission the viewer must hold (see below) |

**Feature or announcement** — you write the content:

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | A short unique label |
| `title` | yes | The headline. One or two lines |
| `body` | yes | Plain text, one or two sentences, **160 characters or fewer**. No markup: it is shown literally |
| `image` | yes | Where the artwork lives, e.g. `"/hero/selfie-mode.webp"` (see Images) |
| `imageAlt` | no | Leave out (or `""`) for decorative art, which is the usual case. Otherwise describe the image |
| `cta` | yes | The button, below |
| `enabled`, `requires` | no | As above |

The **`cta`** is `{ "label": "...", "modal": { ... } }`, and the modal is one of:

- `{ "kind": "feature", "heading": "...", "bodyMarkdown": "...", "image": "..." }` opens an info dialog. `heading` and `bodyMarkdown` are required; `image` is optional. The body is Markdown.
- `{ "kind": "character", "avatar": "ivy.png" }` opens that character's preview dialog instead.

JSON has no comments and no trailing commas. Use `"enabled": false` rather than commenting a slide out.

### `requires`

A permission string such as `"character:create"` or `"project:view"`. The slide is shown only to people who hold it. The vocabulary is the backend's; the list is mirrored in `src/utils/permissions.ts`. Leave it out for everyone.

## What the page does with the file

1. Entries are used **in the order you list them**.
2. These are dropped: `enabled: false`; a `requires` the viewer lacks; and any character (or a feature whose button opens a character) the viewer cannot see.
3. The banner shows the **first 5** that remain. The **Featured characters** row shows every surviving character entry, with no limit.
4. If **no character entry survives**, the banner is replaced by the welcome panel ("Start a new conversation"). Announcements on their own never earn a banner, so put at least one character in the file if you want announcements seen.
5. One surviving slide is shown still, with no arrows or dots. Two or more rotate every 6 seconds.
6. A broken entry is skipped (see Checking your edit); the rest are unaffected.

## Images

- Put artwork in `public/hero/` and refer to it as `/hero/<file>`. `.webp` keeps it small.
- When you replace an image, give it a new file name: browsers may keep the old bytes under the old name, because the server sends no `Cache-Control` header for `/hero/`.
- It fills the banner edge to edge, cropped to fit and anchored to the top, so keep the subject in the **upper right**: the left half is darkened behind the text, and on a phone the bottom half is.
- Around 1600 x 640 pixels works for wide screens. Anything much larger is wasted bytes.
- The first two slides load immediately; later ones load lazily.
- If an image cannot be loaded, the slide stays and shows a big initial letter in its place.

## Pitfalls

- **Avatar names are per user.** A character's avatar file name belongs to whoever owns that card, so `"ivy.png"` may match a viewer's own, different "ivy.png" instead of the one you meant. Choose a card you know the audience can see (shared / global), and check it as an ordinary user.
- **`bodyMarkdown` is not sanitised.** It is rendered as Markdown straight from this file. That is safe only because the file is yours and only a deploy changes it. Never paste text from users into it.
- **Editing the file never needs a code change, but a broken file costs you slides.** An unreadable or wrongly versioned file means no slides, and the page quietly falls back to the welcome panel.

## Checking your edit

- Open the browser console on the home page. Each skipped entry logs one warning naming its position and `id` and saying what is wrong. A file that is not valid JSON, or has the wrong `version`, logs one line saying so.
- Run `npx vitest run tools/heroSlides.test.ts`. It runs the shipped file through the same validator the app uses and **fails if any entry would be skipped**, so a typo cannot reach production unnoticed.
- Check the page as someone who does *not* hold your `requires` permission, and on a phone-width window.

To undo a change, revert the file and deploy.
