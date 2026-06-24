const project = "vocal-vigil-452005-p0";
const db = "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849";

async function run() {
  const url = `https://firestore.googleapis.com/v1/projects/${project}/databases/${db}/documents/sync/tkd_current_event_v3`;
  
  const response = await fetch(url);
  const data = await response.json();
  
  if (data.fields && data.fields.value) {
      console.log("Current Event:", data.fields.value.stringValue);
  } else {
      console.log("Failed to fetch or parse", data);
  }
}
run().catch(console.error);
