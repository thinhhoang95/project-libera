# Notebook illustrations

Every notebook's homepage opens with a wide illustration across the top. The illustrations come in sets; Libera picks one from the chosen set for each notebook, and you can pick one yourself for any notebook.

## Choosing a set

Open Preferences → **General** → **Homepage illustrations**. Each set shows as a tile with its first illustration and small thumbnails of the rest; click one to use it, and save Preferences. Covers change straight away, without a restart.

Two sets are built in:

| Set | Contents |
| --- | --- |
| **Kỷ nguyên vươn mình** (default) | Six Vietnamese monuments: Turtle Tower, One Pillar Pagoda, the Meridian Gate of Huế, Hội An's Covered Bridge, the Po Nagar towers and the Independence Palace |
| **AI Seasons** | The original nine landscapes |

With **AI Seasons**, each notebook keeps the illustration it was given when it was created. With any other set, a notebook's creation time picks its illustration, so a notebook keeps the same picture for as long as the set does.

## Your own sets

Click **New set** to make a set from your own pictures. Name it, then add images with **Add images…** or by dropping them on the dialog (PNG, JPEG, WebP, GIF or AVIF; a set holds up to 200).

Covers are 3:1, much wider than most photos, so every image is cropped:

- Adding a single image opens the crop at once. Adding several centers each crop; adjust any of them afterwards.
- Click an illustration (or its crop button) to pan, zoom and crop it. Drag to pan; scroll, pinch, use the slider or press + and − to zoom; arrow keys pan too. The bright frame is the cover, and **Reset** fits the picture again.
- The arrows on an illustration move it earlier or later, and the bin removes it.

Libera keeps the original picture with each crop, so you can crop again later without losing the rest of the picture.

Right-click one of your sets (or press Shift+F10) to **Use**, **Edit…** or **Delete** it; double-clicking edits it too. The built-in sets cannot be edited or deleted.

## A notebook's own illustration

On a notebook's homepage, choose **New → Change illustration**. The dialog shows the current cover and every set, with the chosen one first. Click any illustration to use it for this notebook, or **Random** to let the chosen set pick again.

The illustration you pick is copied into the notebook, next to its settings, so it stays even if you later delete its set or crop the original again. Picking another one, or going back to Random, deletes the copy.

## Where things are kept

- The choice of set, and each set's name, images and crops, are saved with Preferences and included in Preferences backups. The images themselves are not in the backup.
- Your sets' images live in the library, in `users/admin/.libera/notebook-illustrations/<set>/`: each illustration as a 3:1 JPEG, and the picture it was cropped from as `<id>.source.jpg`. Saving Preferences removes the files of deleted sets and images. When you choose a new master directory, the images are copied there.
- A notebook's own illustration is a hidden `.libera-notebook-cover-….jpg` (or `.png`) file in the notebook's folder, named by `illustrationPath` in its `.libera-notebook.json`. For a linked folder it sits with the folder's Libera settings, not in the folder itself.
