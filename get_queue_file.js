import { initializeApp } from 'firebase/app';
import { getFirestore, getDoc, doc } from 'firebase/firestore';
import fs from 'fs';

const app = initializeApp({ projectId: "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849" });
const db = getFirestore(app);

async function run() {
  const qDoc = await getDoc(doc(db, 'sync', 'tkd_bout_queue'));
  if (qDoc.exists()) {
    const queue = qDoc.data().value || [];
    fs.writeFileSync('queue_dump.json', JSON.stringify(queue, null, 2));
    console.log("Dumped " + queue.length + " bouts");
  } else {
    console.log("No queue");
  }
  process.exit(0);
}
run().catch((e) => { console.error(e); process.exit(1); });
