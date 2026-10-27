using System.ComponentModel.DataAnnotations;

namespace Unbreakable.Models;

public class Message
{
    public int Id { get; set; }

    [Required]
    [StringLength(40, MinimumLength = 2)]
    [Display(Name = "Van")]
    public string Sender { get; set; }

    [Required]
    [StringLength(40, MinimumLength = 2)]
    [Display(Name = "Aan")]
    public string Recipient { get; set; }

    [Required]
    [StringLength(100)]
    [Display(Name = "Onderwerp")]
    public string Subject { get; set; }

    // Enkel de ciphertext (modulo 37, A-Z 0-9 _). Nooit het bericht zelf, nooit de sleutel.
    [Required]
    [StringLength(2000)]
    [Display(Name = "Bericht (versleuteld)")]
    public string Body { get; set; }

    // Het nummer van de lijn in het codeboek. Niet geheim: zonder het codeboek zegt het niets.
    [Display(Name = "Lijn in het codeboek")]
    public int KeyLine { get; set; }

    // HMAC-SHA256 in hex (64 tekens), berekend in de browser van de verzender.
    [StringLength(64)]
    [Display(Name = "MAC")]
    public string Mac { get; set; }

    [Display(Name = "Verzonden")]
    public DateTime SentAt { get; set; }
}
