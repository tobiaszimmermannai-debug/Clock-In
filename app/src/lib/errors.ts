// Datenbank-Fehler verständlich machen
type DbError = { code?: string; message: string } | null | undefined;

export function dbMessage(error: DbError): string {
  if (!error) return "";
  switch (error.code) {
    case "23P01":
      return "Überschneidet sich mit einer anderen Schicht dieser Person.";
    case "42501":
      return "Dafür fehlt die Berechtigung.";
    case "23505":
      return "Dieser Eintrag existiert bereits.";
    case "23514":
      return "Ungültige Angaben (z. B. Ende vor Beginn).";
  }
  return error.message.replace(/^Schichttausch: /, "");
}
