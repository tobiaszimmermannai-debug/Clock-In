// Reiter „Wissen“: Infos, Abläufe und Anleitungen fürs Team (Inhalte folgen)
import { LeadingIcon, PageHeader, Row, Section } from "../components/ui";

export function Knowledge() {
  return (
    <>
      <PageHeader title="Wissen" subtitle="Abläufe, Infos und Anleitungen fürs Studio" />
      <Section title="Bald hier">
        <Row leading={<LeadingIcon name="book" />} title="Inhalte folgen" subtitle="Tobias und Dominik stellen hier gerade das Wissen zusammen." />
      </Section>
    </>
  );
}
