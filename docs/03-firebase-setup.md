# Firebase Setup (FCM)

1. Create a Firebase project
2. Enable Cloud Messaging
3. Create a Service Account
4. Download JSON key
5. Set path in `.env`:

```env
GOOGLE_KEY_FILE=/path/to/firebase-service-account.json
GOOGLE_PROJECT_ID=your-project-id

This project uses HTTP v1 FCM API.
