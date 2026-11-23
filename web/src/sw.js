import { clientsClaim } from 'workbox-core'
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'

self.skipWaiting()
clientsClaim()
cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html')))

self.addEventListener('push', (event) => {
  let payload = {}
  try {
    payload = event.data?.json() ?? {}
  } catch {
    // A missing or malformed payload still produces a visible notification.
  }
  event.waitUntil(self.registration.showNotification(payload.title || 'Happen', {
    body: payload.body || 'Öffne Happen für dein Briefing.',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: payload.tag || 'happen',
    data: { url: payload.url || '/heute' },
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL(event.notification.data?.url || '/heute', self.location.origin)
  const target = url.origin === self.location.origin ? url.href : new URL('/heute', self.location.origin).href
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of windows) {
      if (client.url === target) return client.focus()
    }
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin)
    if (existing) {
      const navigated = await existing.navigate(target)
      if (navigated) return navigated.focus()
    }
    return self.clients.openWindow(target)
  })())
})
