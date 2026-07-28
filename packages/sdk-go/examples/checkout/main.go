package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"time"

	tixkit "github.com/tixkithq/tixkit-go"
)

func main() {
	apiKey := os.Getenv("TIXKIT_API_KEY")
	eventID := os.Getenv("TIXKIT_EVENT_ID")
	ticketTypeID := os.Getenv("TIXKIT_TICKET_TYPE_ID")
	if apiKey == "" || eventID == "" || ticketTypeID == "" {
		log.Fatal("set TIXKIT_API_KEY, TIXKIT_EVENT_ID, and TIXKIT_TICKET_TYPE_ID")
	}

	options := []tixkit.ClientOption{}
	if baseURL := os.Getenv("TIXKIT_API_BASE_URL"); baseURL != "" {
		options = append(options, tixkit.WithBaseURL(baseURL))
	}
	client, err := tixkit.NewClient(apiKey, options...)
	if err != nil {
		log.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	session, err := client.CheckoutSessions.Create(ctx, tixkit.CreateCheckoutSessionRequest{
		EventID: eventID,
		Items: []tixkit.CheckoutItem{{
			TicketTypeID: ticketTypeID,
			Quantity:     1,
		}},
		Buyer: &tixkit.Buyer{
			Email:     "buyer@example.com",
			FirstName: "Ada",
			LastName:  "Lovelace",
		},
		SuccessURL:     "https://example.com/success",
		CancelURL:      "https://example.com/cancel",
		IdempotencyKey: fmt.Sprintf("checkout-%d", time.Now().UnixNano()),
	})
	if err != nil {
		log.Fatal(err)
	}

	fmt.Printf("checkout session %s status=%s url=%s\n", session.ID, session.Status, session.CheckoutURL)
}
