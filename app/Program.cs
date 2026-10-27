using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Newtonsoft.Json;
using Unbreakable.Data;
using Unbreakable.Models;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddDbContext<UnbreakableContext>(options =>
    options.UseNpgsql(builder.Configuration.GetConnectionString("Unbreakable")));

builder.Services.AddCors(options =>
    options.AddDefaultPolicy(policy => policy.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod()));

var app = builder.Build();

// Databank aanmaken en vullen met voorbeeldberichten.
// De databank kan iets later opstarten dan de app, dus we proberen een paar keer.
using (var scope = app.Services.CreateScope())
{
    var context = scope.ServiceProvider.GetRequiredService<UnbreakableContext>();
    var logger = scope.ServiceProvider.GetRequiredService<ILogger<Program>>();

    for (var attempt = 1; attempt <= 30; attempt++)
    {
        try
        {
            context.Database.EnsureCreated();
            // EnsureCreated maakt geen nieuwe kolommen aan in een bestaande databank.
            // Voor opdracht 3 voegen we ze zelf toe als ze nog niet bestaan.
            context.Database.ExecuteSqlRaw(
                "ALTER TABLE \"Messages\" " +
                "ADD COLUMN IF NOT EXISTS \"KeyLine\" integer NOT NULL DEFAULT 0, " +
                "ADD COLUMN IF NOT EXISTS \"Mac\" character varying(64) NULL");
            SeedData.Initialize(context);
            break;
        }
        catch (Exception ex) when (attempt < 30)
        {
            logger.LogWarning("Databank nog niet bereikbaar ({Error}), poging {Attempt}", ex.Message, attempt);
            Thread.Sleep(2000);
        }
    }
}

app.UseDeveloperExceptionPage();
app.UseCors();

// De SPA: index.html, JavaScript en CSS uit wwwroot.
app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet("/health", () => "ok");

// De API. Wie je bent, staat voorlopig in de header X-User.
var api = app.MapGroup("/api");

api.MapGet("/users", async (UnbreakableContext db) =>
{
    var senders = await db.Messages.Select(m => m.Sender).Distinct().ToListAsync();
    var recipients = await db.Messages.Select(m => m.Recipient).Distinct().ToListAsync();
    return Results.Ok(senders.Union(recipients).OrderBy(name => name).ToList());
});

api.MapGet("/messages", async (HttpRequest request, UnbreakableContext db) =>
{
    var user = CurrentUser(request);
    if (string.IsNullOrEmpty(user))
    {
        return Results.Unauthorized();
    }

    var inbox = db.Messages.Where(m => m.Recipient == user);

    var from = request.Query["from"].ToString();
    if (!string.IsNullOrEmpty(from))
    {
        inbox = inbox.Where(m => m.Sender == from);
    }

    return Results.Ok(await inbox.OrderByDescending(m => m.SentAt).ToListAsync());
});

api.MapGet("/messages/search", async (HttpRequest request, UnbreakableContext db) =>
{
    var user = CurrentUser(request);
    if (string.IsNullOrEmpty(user))
    {
        return Results.Unauthorized();
    }

    var q = request.Query["q"].ToString();
    var sql = "SELECT * FROM \"Messages\" WHERE \"Recipient\" = '" + user + "' " +
              "AND (\"Subject\" ILIKE '%" + q + "%' OR \"Body\" ILIKE '%" + q + "%')";

    var messages = await db.Messages.FromSqlRaw(sql).OrderByDescending(m => m.SentAt).ToListAsync();
    return Results.Ok(messages);
});

api.MapGet("/messages/export", async (HttpRequest request, UnbreakableContext db) =>
{
    var user = CurrentUser(request);
    if (string.IsNullOrEmpty(user))
    {
        return Results.Unauthorized();
    }

    var messages = await db.Messages
        .Where(m => m.Recipient == user)
        .OrderBy(m => m.SentAt)
        .ToListAsync();

    return Results.Text(JsonConvert.SerializeObject(messages, Formatting.Indented), "application/json");
});

api.MapGet("/messages/{id:int}", async (int id, UnbreakableContext db) =>
{
    var message = await db.Messages.FindAsync(id);
    return message == null ? Results.NotFound() : Results.Ok(message);
});

api.MapPost("/messages", async (Message message, HttpRequest request, UnbreakableContext db) =>
{
    // Geen afzender meegegeven? Dan nemen we wie je bent.
    if (string.IsNullOrEmpty(message.Sender))
    {
        message.Sender = CurrentUser(request);
    }

    // Opdracht 3: de server kan het bericht niet lezen, maar wel controleren dat er
    // enkel ciphertext binnenkomt in het verwachte formaat.
    if (string.IsNullOrEmpty(message.Body) || !Regex.IsMatch(message.Body, "^[A-Z0-9_]{1,40}$"))
    {
        return Results.BadRequest("Body moet ciphertext zijn: 1 tot 40 tekens uit A-Z, 0-9 en _.");
    }
    if (message.KeyLine < 1)
    {
        return Results.BadRequest("KeyLine ontbreekt.");
    }
    if (string.IsNullOrEmpty(message.Mac) || !Regex.IsMatch(message.Mac, "^[0-9a-f]{64}$"))
    {
        return Results.BadRequest("Mac moet een HMAC-SHA256 in hex zijn (64 tekens).");
    }

    // Een lijn uit het codeboek mag maar één keer gebruikt worden tussen dezelfde twee personen.
    // Twee keer dezelfde sleutel maakt de one time pad breekbaar (C1 - C2 = P1 - P2).
    var reused = await db.Messages.AnyAsync(m => m.KeyLine == message.KeyLine &&
        ((m.Sender == message.Sender && m.Recipient == message.Recipient) ||
         (m.Sender == message.Recipient && m.Recipient == message.Sender)));
    if (reused)
    {
        return Results.Conflict($"Lijn {message.KeyLine} van het codeboek is al gebruikt tussen deze twee personen. Neem een nieuwe lijn.");
    }

    message.Id = 0;
    message.SentAt = DateTime.UtcNow;

    db.Messages.Add(message);
    await db.SaveChangesAsync();

    return Results.Created($"/api/messages/{message.Id}", message);
});

api.MapDelete("/messages/{id:int}", async (int id, UnbreakableContext db) =>
{
    var message = await db.Messages.FindAsync(id);
    if (message == null)
    {
        return Results.NotFound();
    }

    db.Messages.Remove(message);
    await db.SaveChangesAsync();
    return Results.NoContent();
});

app.Run();

static string CurrentUser(HttpRequest request)
{
    return request.Headers["X-User"].ToString();
}
