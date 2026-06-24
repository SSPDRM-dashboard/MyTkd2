import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc } from 'firebase/firestore';

const firebaseConfig = {
  projectId: "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function run() {
  const qDoc = await getDoc(doc(db, 'sync', 'tkd_bout_queue'));
  console.log("Queue size:", qDoc.exists() ? qDoc.data().value.length : 0);
  if (qDoc.exists() && qDoc.data().value.length > 0) {
    console.log("First queue item:", qDoc.data().value[0].data);
  } else {
    console.log("Queue is empty");
  }

  const rDoc = await getDoc(doc(db, 'sync', 'tkd_rings'));
  if (rDoc.exists()) {
    const rings = rDoc.data().value;
    console.log("Rings:", rings.map((r: any) => ({
      ringNumber: r.ringNumber,
      currentBout: r.currentBout?.bout,
      version: r.version
    })));
  }
}
run();
