// Netlify Function: notificar.js
// Recibe { puesto, titulo, cuerpo } cuando un cliente agenda una hora,
// busca los tokens de notificación guardados para ese puesto en Firestore,
// y les envía un push real a través de Firebase Cloud Messaging (FCM),
// aunque el celular del barbero tenga la app cerrada.
//
// No usa ninguna librería externa (solo Node nativo), para poder subirse
// por drag-and-drop sin necesitar "npm install".
//
// Requiere 3 variables de entorno configuradas en Netlify:
//   FIREBASE_PROJECT_ID
//   FIREBASE_CLIENT_EMAIL
//   FIREBASE_PRIVATE_KEY
// (salen del archivo JSON de la cuenta de servicio de Firebase)

const crypto = require('crypto');

function base64url(input){
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function obtenerAccessToken(clientEmail, privateKey, scopes){
  const header = {alg:'RS256', typ:'JWT'};
  const now = Math.floor(Date.now()/1000);
  const claimSet = {
    iss: clientEmail,
    scope: scopes.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };
  const unsigned = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(claimSet));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const firma = signer.sign(privateKey)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const jwt = unsigned + '.' + firma;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + jwt
  });
  const data = await resp.json();
  if(!data.access_token) throw new Error('No se pudo obtener el token de Google: ' + JSON.stringify(data));
  return data.access_token;
}

exports.handler = async function(event){
  if(event.httpMethod !== 'POST'){
    return {statusCode: 405, body: 'Method not allowed'};
  }

  try{
    const body = JSON.parse(event.body || '{}');
    const puesto = body.puesto;
    const titulo = body.titulo;
    const cuerpo = body.cuerpo || '';
    if(!puesto || !titulo){
      return {statusCode: 400, body: JSON.stringify({error: 'Faltan datos (puesto o titulo).'})};
    }

    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
    if(!projectId || !clientEmail || !privateKey){
      return {statusCode: 500, body: JSON.stringify({error: 'Faltan variables de entorno de Firebase en Netlify.'})};
    }

    const accessToken = await obtenerAccessToken(clientEmail, privateKey, [
      'https://www.googleapis.com/auth/datastore',
      'https://www.googleapis.com/auth/firebase.messaging'
    ]);

    // 1) Resolver qué usuario (barbero) está asignado actualmente a este puesto
    const asignUrl = 'https://firestore.googleapis.com/v1/projects/' + projectId +
      '/databases/(default)/documents/config/puesto_a_usuario';
    const asignResp = await fetch(asignUrl, {headers: {Authorization: 'Bearer ' + accessToken}});
    let username = null;
    if(asignResp.ok){
      const asignData = await asignResp.json();
      const mapaValue = asignData.fields && asignData.fields.mapa && asignData.fields.mapa.mapValue;
      const campos = mapaValue && mapaValue.fields;
      if(campos && campos[String(puesto)]){
        username = campos[String(puesto)].stringValue;
      }
    }
    if(!username){
      return {statusCode: 200, body: JSON.stringify({ok: true, enviados: 0, aviso: 'No hay un barbero asignado a ese puesto.'})};
    }

    // 2) Leer los tokens de notificación guardados para ESE usuario
    const docUrl = 'https://firestore.googleapis.com/v1/projects/' + projectId +
      '/databases/(default)/documents/fcm_tokens/' + username;
    const docResp = await fetch(docUrl, {headers: {Authorization: 'Bearer ' + accessToken}});
    let tokens = [];
    if(docResp.ok){
      const docData = await docResp.json();
      const arrayValue = docData.fields && docData.fields.tokens && docData.fields.tokens.arrayValue;
      if(arrayValue && arrayValue.values){
        tokens = arrayValue.values.map(v => v.stringValue).filter(Boolean);
      }
    }

    if(tokens.length === 0){
      return {statusCode: 200, body: JSON.stringify({ok: true, enviados: 0, aviso: 'No hay dispositivos registrados para este puesto.'})};
    }

    // 2) Enviar el push a cada dispositivo registrado para ese puesto
    let enviados = 0;
    for(const token of tokens){
      const sendResp = await fetch('https://fcm.googleapis.com/v1/projects/' + projectId + '/messages:send', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + accessToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message: {
            token: token,
            notification: {title: titulo, body: cuerpo},
            webpush: {fcm_options: {link: './'}}
          }
        })
      });
      if(sendResp.ok) enviados++;
    }

    return {statusCode: 200, body: JSON.stringify({ok: true, enviados: enviados})};
  }catch(e){
    return {statusCode: 500, body: JSON.stringify({error: e.message})};
  }
};
