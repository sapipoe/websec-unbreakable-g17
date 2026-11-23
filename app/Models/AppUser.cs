using System.ComponentModel.DataAnnotations;

namespace Unbreakable.Models;

// Opdracht 4: koppelt de identiteit uit het token aan een naam die je kan tonen.
public class AppUser
{
    // De claim "sub" uit het access token: uniek, altijd aanwezig, nooit hergebruikt.
    [StringLength(64)]
    public string Id { get; set; }

    // De claim "preferred_username": enkel om te tonen, niet om iemand te herkennen.
    [StringLength(100)]
    public string Username { get; set; }
}
