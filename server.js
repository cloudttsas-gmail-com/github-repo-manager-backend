import 'dotenv/config';
import app from './src/app.js';
import connectDB from './src/config/database.js';
import { startCampaignWorker } from './src/services/campaignSender.service.js';

const PORT = process.env.PORT || 5000;

// On Vercel, the database connection is also handled via middleware in app.js
// but we keep this here for local development and warm-up.
const startServer = async () => {
  try {
    await connectDB();

    // Only listen if NOT on Vercel (local development)
    if (!process.env.VERCEL) {
      app.listen(PORT, () => {
        console.log(`Server running in ${process.env.NODE_ENV || 'development'} mode on port ${PORT}`);
      });
      // WhatsApp sends go out from this process (there is no other scheduler)
      startCampaignWorker();
    }
  } catch (error) {
    console.error('Failed to start database connection:', error.message);
    // In local dev we exit, in serverless we let Vercel handle the function state
    if (!process.env.VERCEL) {
      process.exit(1);
    }
  }
};

startServer();

// Important for Vercel: export the app as the default export
export default app;

process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err.message);
  if (!process.env.VERCEL) process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err.message);
  if (!process.env.VERCEL) process.exit(1);
});
