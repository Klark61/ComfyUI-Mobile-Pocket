// Imported first by app.js so the old comfymobile.* storage keys are moved before any other module reads them.
import { migrateAll } from '/pocket/static/canvas/storage-migrate.js';
migrateAll();
