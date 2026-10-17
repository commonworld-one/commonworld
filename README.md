# atlas-screens (orphan branch)

Homepage screenshots for the [Commonworld Atlas](https://commonworld.one/atlas/). This branch holds **only** images and
their manifest; it never merges into `main`.

- `atlas/screens/<slug>.webp`: 1200x750 WebP of the card's homepage (1280x800 viewport, one viewport, no login).
- `atlas/screens/manifest.json`: one record per image (sha256, dhash, source_url, captured_at UTC, size).

`atlas/site/build.py` on `main` fetches this branch at build time (git fetch, or the public tarball as fallback),
copies the images to `/atlas/screens/` and makes 480x300 thumbnails. Without this branch the site builds with no previews.

The screenshots show third-party websites. Their content remains the property of the respective site owners and is
**not** licensed under the Atlas CC BY 4.0 data licence (nor MIT). Site owners can ask for a screenshot to be replaced
or removed through the Atlas corrections link. History stays in this branch; closed cards keep their last capture.
