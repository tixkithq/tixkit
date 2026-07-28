/**
 * Locale-aware checkout chrome for the buyer's critical path.
 *
 * Event content uses its published locale. Checkout accepts that same locale
 * through `?locale=` and falls back by language, then to English.
 */

export type CheckoutCopy = {
  checkout: string;
  backToEvent: string;
  continue: string;
  placeFreeOrder: string;
  payPrefix: string;
  editOrder: string;
  startNewOrder: string;
  retryReservationCheck: string;
  retryCheckoutFields: string;
  checkingReservation: string;
  checkingReservationDetail: string;
  checkoutExpiredTitle: string;
  checkoutUnavailableTitle: string;
  checkoutExpiredBody: string;
  reservationUnverifiedTitle: string;
  reservationUnverifiedBody: string;
  inventoryChangedTitle: string;
  inventoryChangedAcknowledge: string;
  inventoryReviewSelection: string;
  networkOfflineTitle: string;
  networkUnreachableTitle: string;
  networkRetry: string;
  checkoutErrorTitle: string;
  pleaseFixTitle: string;
  orderSummary: string;
  yourDetails: string;
  payment: string;
  selectTickets: string;
  loadingCheckoutFieldsTitle: string;
  loadingCheckoutFieldsBody: string;
  checkoutFieldsUnavailableTitle: string;
  orderComplete: string;
  redirectingConfirmation: string;
  sessionReservedUntil: (time: string) => string;
};

const catalogs: Record<'en' | 'es' | 'fr' | 'de' | 'pt', CheckoutCopy> = {
  en: {
    checkout: 'Checkout',
    backToEvent: 'Back to event',
    continue: 'Continue',
    placeFreeOrder: 'Place free order',
    payPrefix: 'Pay',
    editOrder: 'Edit order',
    startNewOrder: 'Start new order',
    retryReservationCheck: 'Retry reservation check',
    retryCheckoutFields: 'Retry checkout fields',
    checkingReservation: 'Checking reservation',
    checkingReservationDetail: 'Checking whether your ticket reservation is still valid…',
    checkoutExpiredTitle: 'Checkout expired',
    checkoutUnavailableTitle: 'Checkout unavailable',
    checkoutExpiredBody:
      'Your checkout session expired. Start a new order to reserve tickets again.',
    reservationUnverifiedTitle: 'Reservation could not be verified',
    reservationUnverifiedBody:
      'We could not confirm your ticket reservation. Payment is paused until the reservation is revalidated.',
    inventoryChangedTitle: 'Your selection changed',
    inventoryChangedAcknowledge: 'I understand — update my selection',
    inventoryReviewSelection: 'Review selection',
    networkOfflineTitle: 'You are offline',
    networkUnreachableTitle: 'Connection problem',
    networkRetry: 'Retry',
    checkoutErrorTitle: 'Checkout error',
    pleaseFixTitle: 'Please fix the following',
    orderSummary: 'Order summary',
    yourDetails: 'Your details',
    payment: 'Payment',
    selectTickets: 'Select tickets',
    loadingCheckoutFieldsTitle: 'Loading checkout fields',
    loadingCheckoutFieldsBody:
      'Required buyer and attendee fields are loading before checkout can continue.',
    checkoutFieldsUnavailableTitle: 'Checkout fields unavailable',
    orderComplete: 'Order complete',
    redirectingConfirmation: 'Redirecting to your confirmation…',
    sessionReservedUntil: (time) =>
      `Session reserved until ${time}. Your tickets are held while you complete checkout. We re-check the reservation with the server when that time is reached.`,
  },
  es: {
    checkout: 'Pago',
    backToEvent: 'Volver al evento',
    continue: 'Continuar',
    placeFreeOrder: 'Completar pedido gratuito',
    payPrefix: 'Pagar',
    editOrder: 'Editar pedido',
    startNewOrder: 'Iniciar un nuevo pedido',
    retryReservationCheck: 'Volver a comprobar la reserva',
    retryCheckoutFields: 'Volver a cargar los campos',
    checkingReservation: 'Comprobando la reserva',
    checkingReservationDetail: 'Comprobando si tu reserva de entradas sigue vigente…',
    checkoutExpiredTitle: 'La compra caducó',
    checkoutUnavailableTitle: 'La compra no está disponible',
    checkoutExpiredBody:
      'Tu sesión de compra caducó. Inicia un nuevo pedido para reservar entradas de nuevo.',
    reservationUnverifiedTitle: 'No se pudo verificar la reserva',
    reservationUnverifiedBody:
      'No pudimos confirmar tu reserva. El pago está pausado hasta que se vuelva a validar.',
    inventoryChangedTitle: 'Tu selección cambió',
    inventoryChangedAcknowledge: 'Entendido — actualizar mi selección',
    inventoryReviewSelection: 'Revisar selección',
    networkOfflineTitle: 'No tienes conexión',
    networkUnreachableTitle: 'Problema de conexión',
    networkRetry: 'Reintentar',
    checkoutErrorTitle: 'Error de compra',
    pleaseFixTitle: 'Corrige lo siguiente',
    orderSummary: 'Resumen del pedido',
    yourDetails: 'Tus datos',
    payment: 'Pago',
    selectTickets: 'Seleccionar entradas',
    loadingCheckoutFieldsTitle: 'Cargando campos de compra',
    loadingCheckoutFieldsBody:
      'Los campos obligatorios del comprador y asistentes se están cargando.',
    checkoutFieldsUnavailableTitle: 'Los campos de compra no están disponibles',
    orderComplete: 'Pedido completado',
    redirectingConfirmation: 'Redirigiendo a la confirmación…',
    sessionReservedUntil: (time) =>
      `Reserva vigente hasta las ${time}. Tus entradas están retenidas mientras completas la compra. Volveremos a comprobar la reserva con el servidor al llegar esa hora.`,
  },
  fr: {
    checkout: 'Paiement',
    backToEvent: "Retour à l'événement",
    continue: 'Continuer',
    placeFreeOrder: 'Valider la commande gratuite',
    payPrefix: 'Payer',
    editOrder: 'Modifier la commande',
    startNewOrder: 'Commencer une nouvelle commande',
    retryReservationCheck: 'Revérifier la réservation',
    retryCheckoutFields: 'Recharger les champs',
    checkingReservation: 'Vérification de la réservation',
    checkingReservationDetail: 'Vérification de la validité de votre réservation…',
    checkoutExpiredTitle: 'Paiement expiré',
    checkoutUnavailableTitle: 'Paiement indisponible',
    checkoutExpiredBody:
      'Votre session a expiré. Commencez une nouvelle commande pour réserver des billets.',
    reservationUnverifiedTitle: 'Réservation non vérifiée',
    reservationUnverifiedBody:
      'Nous ne pouvons pas confirmer votre réservation. Le paiement reste suspendu.',
    inventoryChangedTitle: 'Votre sélection a changé',
    inventoryChangedAcknowledge: 'Compris — mettre à jour ma sélection',
    inventoryReviewSelection: 'Revoir la sélection',
    networkOfflineTitle: 'Vous êtes hors ligne',
    networkUnreachableTitle: 'Problème de connexion',
    networkRetry: 'Réessayer',
    checkoutErrorTitle: 'Erreur de paiement',
    pleaseFixTitle: 'Veuillez corriger les éléments suivants',
    orderSummary: 'Récapitulatif',
    yourDetails: 'Vos coordonnées',
    payment: 'Paiement',
    selectTickets: 'Choisir les billets',
    loadingCheckoutFieldsTitle: 'Chargement des champs',
    loadingCheckoutFieldsBody: 'Les champs obligatoires sont en cours de chargement.',
    checkoutFieldsUnavailableTitle: 'Champs de paiement indisponibles',
    orderComplete: 'Commande terminée',
    redirectingConfirmation: 'Redirection vers la confirmation…',
    sessionReservedUntil: (time) =>
      `Réservation valable jusqu'à ${time}. Vos billets sont retenus pendant le paiement. La réservation sera revérifiée à cette heure.`,
  },
  de: {
    checkout: 'Bestellung',
    backToEvent: 'Zurück zur Veranstaltung',
    continue: 'Weiter',
    placeFreeOrder: 'Kostenlose Bestellung abschließen',
    payPrefix: 'Bezahlen',
    editOrder: 'Bestellung bearbeiten',
    startNewOrder: 'Neue Bestellung starten',
    retryReservationCheck: 'Reservierung erneut prüfen',
    retryCheckoutFields: 'Felder erneut laden',
    checkingReservation: 'Reservierung wird geprüft',
    checkingReservationDetail: 'Die Gültigkeit Ihrer Ticketreservierung wird geprüft…',
    checkoutExpiredTitle: 'Bestellung abgelaufen',
    checkoutUnavailableTitle: 'Bestellung nicht verfügbar',
    checkoutExpiredBody:
      'Ihre Sitzung ist abgelaufen. Starten Sie eine neue Bestellung, um Tickets zu reservieren.',
    reservationUnverifiedTitle: 'Reservierung konnte nicht geprüft werden',
    reservationUnverifiedBody:
      'Ihre Reservierung konnte nicht bestätigt werden. Die Zahlung bleibt pausiert.',
    inventoryChangedTitle: 'Ihre Auswahl hat sich geändert',
    inventoryChangedAcknowledge: 'Verstanden — Auswahl aktualisieren',
    inventoryReviewSelection: 'Auswahl prüfen',
    networkOfflineTitle: 'Sie sind offline',
    networkUnreachableTitle: 'Verbindungsproblem',
    networkRetry: 'Erneut versuchen',
    checkoutErrorTitle: 'Bestellfehler',
    pleaseFixTitle: 'Bitte Folgendes korrigieren',
    orderSummary: 'Bestellübersicht',
    yourDetails: 'Ihre Angaben',
    payment: 'Zahlung',
    selectTickets: 'Tickets auswählen',
    loadingCheckoutFieldsTitle: 'Bestellfelder werden geladen',
    loadingCheckoutFieldsBody: 'Erforderliche Felder werden geladen.',
    checkoutFieldsUnavailableTitle: 'Bestellfelder nicht verfügbar',
    orderComplete: 'Bestellung abgeschlossen',
    redirectingConfirmation: 'Weiterleitung zur Bestätigung…',
    sessionReservedUntil: (time) =>
      `Reservierung gültig bis ${time}. Ihre Tickets werden während der Bestellung gehalten und dann erneut geprüft.`,
  },
  pt: {
    checkout: 'Finalização',
    backToEvent: 'Voltar ao evento',
    continue: 'Continuar',
    placeFreeOrder: 'Concluir pedido gratuito',
    payPrefix: 'Pagar',
    editOrder: 'Editar pedido',
    startNewOrder: 'Iniciar novo pedido',
    retryReservationCheck: 'Verificar reserva novamente',
    retryCheckoutFields: 'Carregar campos novamente',
    checkingReservation: 'A verificar a reserva',
    checkingReservationDetail: 'A verificar se a reserva dos bilhetes continua válida…',
    checkoutExpiredTitle: 'Finalização expirada',
    checkoutUnavailableTitle: 'Finalização indisponível',
    checkoutExpiredBody:
      'A sua sessão expirou. Inicie um novo pedido para reservar bilhetes novamente.',
    reservationUnverifiedTitle: 'Não foi possível verificar a reserva',
    reservationUnverifiedBody:
      'Não conseguimos confirmar a reserva. O pagamento está pausado até nova validação.',
    inventoryChangedTitle: 'A sua seleção mudou',
    inventoryChangedAcknowledge: 'Entendi — atualizar seleção',
    inventoryReviewSelection: 'Rever seleção',
    networkOfflineTitle: 'Está offline',
    networkUnreachableTitle: 'Problema de ligação',
    networkRetry: 'Tentar novamente',
    checkoutErrorTitle: 'Erro na finalização',
    pleaseFixTitle: 'Corrija o seguinte',
    orderSummary: 'Resumo do pedido',
    yourDetails: 'Os seus dados',
    payment: 'Pagamento',
    selectTickets: 'Selecionar bilhetes',
    loadingCheckoutFieldsTitle: 'A carregar campos',
    loadingCheckoutFieldsBody: 'Os campos obrigatórios estão a ser carregados.',
    checkoutFieldsUnavailableTitle: 'Campos indisponíveis',
    orderComplete: 'Pedido concluído',
    redirectingConfirmation: 'A redirecionar para a confirmação…',
    sessionReservedUntil: (time) =>
      `Reserva válida até ${time}. Os bilhetes ficam retidos durante a finalização e serão verificados novamente nessa hora.`,
  },
};

export function getCheckoutCopy(locale: string | undefined): CheckoutCopy {
  return catalogs[resolveCheckoutLocale(locale)];
}

export function resolveCheckoutLocale(locale: string | undefined): keyof typeof catalogs {
  const language = locale?.trim().toLowerCase().split(/[-_]/u, 1)[0];
  return language === 'es' || language === 'fr' || language === 'de' || language === 'pt'
    ? language
    : 'en';
}

export const checkoutCopy = catalogs.en;
