# Backend setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in every value (the file explains how to generate each one).
   **Never commit `.env`** and never paste its values into chats or tickets.
3. Firebase key for push notifications:
   - Firebase console → Project settings → Service accounts → *Generate new private key*
   - turn the downloaded JSON into one line and put it in `.env`:
     `node -e "console.log(Buffer.from(require('fs').readFileSync('key.json')).toString('base64'))"`
   - **delete the JSON file afterwards**; the `.env` value is the only copy you need
4. `npm start` (or `npm run dev`). A "FATAL" message at start-up names the missing variable.
5. `npm test` runs the whole suite against a temporary database (nothing to install).

If a key or password was ever shared, committed, or zipped and sent anywhere, treat it as
leaked: rotate it (new MongoDB password, new Firebase key, delete the old key in Google Cloud).
