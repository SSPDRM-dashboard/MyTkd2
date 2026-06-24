const project = "vocal-vigil-452005-p0";
const db = "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849";

async function run() {
  const url = `https://firestore.googleapis.com/v1/projects/${project}/databases/${db}/documents/matchHistory`;
  let pageToken = "";
  let found = [];
  do {
      const pageUrl = pageToken ? `${url}?pageToken=${pageToken}&pageSize=300` : `${url}?pageSize=300`;
      const response = await fetch(pageUrl);
      const data = await response.json();
      
      if (data.documents) {
          data.documents.forEach(d => {
              const fields = d.fields || {};
              const eventId = fields.eventId?.stringValue;
              const boutObj = fields.bout?.stringValue || fields.bout?.integerValue || '';
              const bout = String(boutObj).toUpperCase();
              if (eventId === '9x893h9gl' && ['17', '18', '19', '20', '21', '22', 'C17', 'C18', 'C19', 'C20', 'C21', 'C22'].some(num => bout.includes(num))) {
                  found.push(`${bout} - ${fields.winner?.stringValue} (Ring: ${fields.ring?.integerValue})`);
              }
          });
      }
      pageToken = data.nextPageToken || "";
  } while(pageToken);
  
  console.log("Found in history:");
  found.forEach(f => console.log(f));
}
run().catch(console.error);
