import { initializeApp } from 'firebase/app';
import { getFirestore, getDoc, doc } from 'firebase/firestore';
import fs from 'fs';

const app = initializeApp(JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf8')));
const db = getFirestore(app, "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849");

async function run() {
  const currentEventDoc = await getDoc(doc(db, 'sync', 'tkd_current_event_v3'));
  console.log("=== tkd_current_event_v3 ===");
  if (currentEventDoc.exists()) {
    console.log(JSON.stringify(currentEventDoc.data(), null, 2));
  } else {
    console.log("Not found.");
  }

  const eventsDoc = await getDoc(doc(db, 'sync', 'tkd_events_v3'));
  console.log("\n=== tkd_events_v3 ===");
  if (eventsDoc.exists()) {
    const events = eventsDoc.data().value || [];
    console.log(`Number of events found: ${events.length}`);
    events.forEach((e: any, i: number) => {
      console.log(`Event [${i}]: ID: ${e.id} | Name: "${e.name}" | Spreadsheet: "${e.spreadsheetUrl || e.spreadsheet_url || e.sheetUrl || 'None'}"`);
    });
  } else {
    console.log("Not found.");
  }

  process.exit(0);
}

run();
