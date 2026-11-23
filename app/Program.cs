using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;
using Newtonsoft.Json;
using Unbreakable.Data;
using Unbreakable.Models;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddDbContext<UnbreakableContext>(options =>
    options.UseNpgsql(builder.Configuration.GetConnectionString("Unbreakable")));

// Opdracht 4: wie je bent, komt uit het access token van Keycloak.
// De API controleert elk token zelf: handtekening, issuer, audience en geldigheidsduur.
var oidc = builder.Configuration.GetSection("Oidc");
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        // De publieke sleutels van Keycloak halen we over het interne Docker-netwerk,
        // niet via het internet. Daarom http: dit verkeer verlaat de server niet.
        options.MetadataAddress = oidc["MetadataAddress"];
        options.RequireHttpsMetadata = false;

        // Claims laten zoals ze in het token staan ("sub" blijft "sub").
        options.MapInboundClaims = false;

        options.TokenValidationParameters = new TokenValidationParameters
        {
            // 1. Handtekening: enkel RS256, met de publieke sleutel van Keycloak.
            ValidateIssuerSigningKey = true,
            RequireSignedTokens = true,
            ValidAlgorithms = new[] { SecurityAlgorithms.RsaSha256 },

            // 2. Issuer: exact onze realm, op het publieke adres.
            ValidateIssuer = true,
            ValidIssuer = oidc["Issuer"],

            // 3. Audience: het token moet voor deze API bedoeld zijn.
            ValidateAudience = true,
            ValidAudience = oidc["Audience"],

            // 4. Geldigheidsduur: niet verlopen, met hoogstens 30 seconden speling op de klok.
            ValidateLifetime = true,
            RequireExpirationTime = true,
            ClockSkew = TimeSpan.FromSeconds(30),

            // De gebruiker is de claim "sub": altijd aanwezig, uniek en nooit hergebruikt.
            NameClaimType = "sub",
        };
    });
builder.Services.AddAuthorization();

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
            // Opdracht 4: tabel die de sub uit het token koppelt aan een leesbare naam.
            context.Database.ExecuteSqlRaw(
                "CREATE TABLE IF NOT EXISTS \"Users\" (" +
                "\"Id\" character varying(64) NOT NULL PRIMARY KEY, " +
                "\"Username\" character varying(100) NOT NULL)");
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

app.UseAuthentication();
app.UseAuthorization();

// Opdracht 4: bij elk verzoek met een geldig token bewaren we welke naam bij welke sub hoort.
// Zo kan je een bericht naar "bram" sturen terwijl de API zijn sub opslaat.
app.Use(async (context, next) =>
{
    var sub = context.User.FindFirst("sub")?.Value;
    if (!string.IsNullOrEmpty(sub))
    {
        var username = context.User.FindFirst("preferred_username")?.Value ?? sub;
        var db = context.RequestServices.GetRequiredService<UnbreakableContext>();
        await db.Database.ExecuteSqlInterpolatedAsync(
            $"INSERT INTO \"Users\" (\"Id\", \"Username\") VALUES ({sub}, {username}) ON CONFLICT (\"Id\") DO UPDATE SET \"Username\" = EXCLUDED.\"Username\"");
    }
    await next();
});

app.MapGet("/health", () => "ok");

// De API. Elk verzoek moet een geldig access token hebben (header Authorization: Bearer ...).
// De header X-User bestaat niet meer.
var api = app.MapGroup("/api").RequireAuthorization();

// Alle gebruikers die al eens ingelogd hebben: sub (id) en leesbare naam.
api.MapGet("/users", async (UnbreakableContext db) =>
{
    var users = await db.Users
        .OrderBy(u => u.Username)
        .Select(u => new { id = u.Id, username = u.Username })
        .ToListAsync();
    return Results.Ok(users);
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
    // Opdracht 4: de afzender komt altijd uit het token, nooit uit de body.
    // Vroeger kon je hier zelf een andere afzender invullen (spoofing).
    message.Sender = CurrentUser(request);
    if (string.IsNullOrEmpty(message.Sender))
    {
        return Results.Unauthorized();
    }

    // De ontvanger is een sub. Die moet bestaan, anders kan niemand het bericht ooit lezen.
    if (string.IsNullOrEmpty(message.Recipient) || !await db.Users.AnyAsync(u => u.Id == message.Recipient))
    {
        return Results.BadRequest("Onbekende ontvanger. Die persoon moet minstens één keer ingelogd hebben.");
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

// Opdracht 4: wie je bent, is de claim "sub" uit het gecontroleerde access token.
static string CurrentUser(HttpRequest request)
{
    return request.HttpContext.User.FindFirst("sub")?.Value;
}
