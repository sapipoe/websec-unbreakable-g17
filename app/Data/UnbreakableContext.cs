using Microsoft.EntityFrameworkCore;
using Unbreakable.Models;

namespace Unbreakable.Data;

public class UnbreakableContext : DbContext
{
    public UnbreakableContext(DbContextOptions<UnbreakableContext> options)
        : base(options)
    {
    }

    public DbSet<Message> Messages { get; set; }

    // Opdracht 4: sub uit het token <-> leesbare naam.
    public DbSet<AppUser> Users { get; set; }
}
