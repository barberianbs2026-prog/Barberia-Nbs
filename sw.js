// Service Worker mínimo de Barbería NBS.
// Su única función por ahora es permitir mostrar notificaciones locales
// (registration.showNotification), ya que Android exige pasar por un
// Service Worker para poder mostrarlas — no basta con "new Notification()".

self.addEventListener('install', function(event){
  self.skipWaiting();
});

self.addEventListener('activate', function(event){
  event.waitUntil(self.clients.claim());
});

// Recibe el push real enviado desde el servidor (Netlify Function) vía FCM,
// y muestra el aviso aunque la app esté completamente cerrada.
self.addEventListener('push', function(event){
  let payload = {};
  try{ payload = event.data ? event.data.json() : {}; }catch(e){}
  const titulo = (payload.notification && payload.notification.title) || 'Barbería NBS';
  const cuerpo = (payload.notification && payload.notification.body) || '';
  event.waitUntil(self.registration.showNotification(titulo, {body: cuerpo, icon: 'icon-192.png'}));
});

self.addEventListener('notificationclick', function(event){
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({type:'window'}).then(function(clientList){
      for(const client of clientList){
        if('focus' in client) return client.focus();
      }
      if(self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});
