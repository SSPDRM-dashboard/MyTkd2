import { initializeApp } from 'firebase/app';
import { getFirestore, getDoc, doc, setDoc } from 'firebase/firestore';

const app = initializeApp({ projectId: "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849" });
const db = getFirestore(app, "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849");

async function fix() {
  const currentEventId = '9x893h9gl';
  const qDoc = await getDoc(doc(db, 'sync', 'tkd_bout_queue'));
  
  if (qDoc.exists()) {
    let queue = qDoc.data().value || [];
    let updated = 0;
    
    // Check existing bouts in the new event
    const existingBouts = new Set(
        queue.filter((q: any) => q.data.eventId === currentEventId)
             .map((q: any) => String(q.data.bout).toUpperCase())
    );
    
    const newQueue = queue.map((q: any) => {
        if (q.data.eventId === 'hyihmup5f') {
            const bout = String(q.data.bout).toUpperCase();
            // Only migrate if it doesn't already exist in the new event to prevent duplicates
            if (!existingBouts.has(bout)) {
                updated++;
                q.data.eventId = currentEventId;
            }
        }
        return q;
    });
    
    // Filter out any that still have the old eventId (meaning they were duplicates)
    const finalQueue = newQueue.filter((q: any) => q.data.eventId === currentEventId);
    
    console.log(`Migrated ${updated} orphaned bouts to new event ID ${currentEventId}. Final queue size: ${finalQueue.length}. Original was ${queue.length}.`);
    
    await setDoc(doc(db, 'sync', 'tkd_bout_queue'), { value: finalQueue });
    console.log("Fixed orphaned queue!");
  }
  process.exit(0);
}
fix().catch(console.error);
