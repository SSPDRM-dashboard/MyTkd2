const project = "vocal-vigil-452005-p0";
const db = "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849";

async function run() {
  const url = `https://firestore.googleapis.com/v1/projects/${project}/databases/${db}/documents/matchHistory`;
  let pageToken = "";
  let count = 0;
  let qweCount = 0;
  do {
      const pageUrl = pageToken ? `${url}?pageToken=${pageToken}&pageSize=300` : `${url}?pageSize=300`;
      const response = await fetch(pageUrl);
      const data = await response.json();
      
      if (data.documents) {
          data.documents.forEach(d => {
              const fields = d.fields || {};
              const eventId = fields.eventId?.stringValue;
              if (eventId === 'hyihmup5f') count++;
              if (eventId === '9x893h9gl') qweCount++;
          });
      }
      pageToken = data.nextPageToken || "";
  } while(pageToken);
  
  console.log(`History bounds: hyihmup5f = ${count}, 9x893h9gl = ${qweCount}`);
}
run().catch(console.error);
