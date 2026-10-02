// Invest panel at the top of a book's page (/books/:bookId). Owned by the Invest page agent:
// deposit into Senior or Junior of this book (open subscription window or top-up round).
import { Card } from "../../components/ui";
import type { BookDetail } from "../../lib/api-types";

export function InvestPanel({ book }: { book: BookDetail; now: number }) {
  return (
    <Card className="mb-5" tone="accent" padding="md" eyebrow="Invest" title={`Invest in book #${book.bookId}`} description="Coming soon: deposit into this book's Senior or Junior tranche from here." />
  );
}
