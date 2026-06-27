/**
 * Centralized route constants for the admin dashboard.
 * Use these instead of hard-coded path strings so navigation stays consistent.
 */
export const routes = {
  root: '/',
  dashboard: '/dashboard',
  events: '/events',
  eventDetail: (eventId: string) => `/events/${eventId}`,
  eventTickets: (eventId: string) => `/events/${eventId}/tickets`,
  eventProducts: (eventId: string) => `/events/${eventId}/products`,
  eventCheckoutForm: (eventId: string) => `/events/${eventId}/checkout-form`,
  eventAttendees: (eventId: string) => `/events/${eventId}/attendees`,
  eventCheckIn: (eventId: string) => `/events/${eventId}/check-in`,
  eventMessages: (eventId: string) => `/events/${eventId}/messages`,
  eventReports: (eventId: string) => `/events/${eventId}/reports`,
  orders: '/orders',
  orderDetail: (orderId: string) => `/orders/${orderId}`,
  attendees: '/attendees',
  checkIn: '/check-in',
  messages: '/messages',
  reports: '/reports',
  developer: '/developer',
  developerApiKeys: '/developer/api-keys',
  developerWebhooks: '/developer/webhooks',
  settings: '/settings',
  settingsProfile: '/settings/profile',
  settingsOrganization: '/settings/organization',
  settingsAppearance: '/settings/appearance',
  settingsTeam: '/settings/team',
  settingsBilling: '/settings/billing',
  settingsPayments: '/settings/payments',
  settingsBranding: '/settings/branding',
  help: '/help',
  auditLog: '/audit-log',
  signIn: '/sign-in',
  signUp: '/sign-up',
} as const

export type RouteKey = keyof typeof routes
