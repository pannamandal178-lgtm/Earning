importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBM-QGSRKCESoaRfkz24yaMt6Kc1GqYg5Y",
  authDomain: "earn-6e68f.firebaseapp.com",
  databaseURL: "https://earn-6e68f-default-rtdb.firebaseio.com",
  projectId: "earn-6e68f",
  storageBucket: "earn-6e68f.firebasestorage.app",
  messagingSenderId: "541250413438",
  appId: "1:541250413438:web:111aec4e1228b8e85d892f"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  console.log('[firebase-messaging-sw.js] Received background message ', payload);
  const notificationTitle = payload.notification.title;
  const notificationOptions = {
    body: payload.notification.body,
    icon: '/firebase-logo.png'
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});
