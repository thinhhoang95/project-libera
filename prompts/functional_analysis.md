# Libera Note-taking App

The goal is to make Libera a polyvalent note-taking app. This note-taking app is folder-based, and is stored on the server, un-encrypted. The encryption will be based on a more disk file encryption technique to be implemented later. There is a small need for authentication, but to keep things simple, let's do Password-based authentication first.

You can decide the best way to implement server-side, and whether it is needed at all.

## Key Functionalities
- Each user will possess one master directory. Then each folder underneath will be one notebook.
- Inside the notebook, the user can put anything they like: but for now we limit to Markdown documents (.md files), photos, PDF files.

## General UI
It should resemble a file browser/file explorer: on the left pane there is notebook, you can expand or collapse the notebooks, and see all the file underneath. There is also a search bar to quickly find the files by name which will display the results at instant in the suggestion box, and you can open the markdown or photos or pdfs in tabs.

### Markdown Notetaking
- The Markdown editor will have key formatting tools: Bold, Italic, Underline, inserting photo, choosing headings... (the usual thing found in word editors that markdown supports).
- There is a preview panel so the user can check out formatted document.
- We will deal with photos and PDF annotations later.
