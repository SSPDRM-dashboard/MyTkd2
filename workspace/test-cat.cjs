const { initializeApp } = require("firebase/app");
const { getFirestore, doc, getDoc } = require("firebase/firestore");

const firebaseConfig = {
  projectId: "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849"
};
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function check() {
  const snap = await getDoc(doc(db, "sync", "tkd_categories"));
  if (snap.exists()) {
    console.log(JSON.stringify(snap.data(), null, 2));
  } else {
    console.log("tkd_categories not found");
  }
}
check();
