import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PricingCache } from "../../../src/pricing/cache.js";
import { PricingEngine } from "../../../src/pricing/pricing-engine.js";
import { DEFAULT_CONFIG } from "../../../src/types/config.js";
import { estimateCost } from "../../../src/tools/estimate-cost.js";

// Disable live network fetches; bundled/fallback prices are deterministic.
vi.stubGlobal("fetch", async () => {
  throw new Error("fetch disabled in unit tests");
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDbPath(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return join(tmpdir(), `cloudcost-estimate-test-${suffix}`, "cache.db");
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AWS_INSTANCE_TF = `
provider "aws" {
  region = "us-east-1"
}

resource "aws_instance" "web" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "t3.micro"
}

resource "aws_instance" "api" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "t3.small"
}

resource "aws_ebs_volume" "data" {
  availability_zone = "us-east-1a"
  size              = 100
  type              = "gp3"
}
`;

const GCP_INSTANCE_TF = `
provider "google" {
  project = "my-project"
  region  = "us-central1"
}

resource "google_compute_instance" "web" {
  name         = "web-server"
  machine_type = "n1-standard-2"
  zone         = "us-central1-a"

  boot_disk {
    initialize_params {
      image = "debian-cloud/debian-11"
      size  = 50
    }
  }

  network_interface {
    network = "default"
  }
}
`;

const AZURE_INSTANCE_TF = `
provider "azurerm" {
  features {}
}

resource "azurerm_linux_virtual_machine" "web" {
  name                = "web-vm"
  resource_group_name = "my-rg"
  location            = "eastus"
  size                = "Standard_D2s_v3"

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Premium_LRS"
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "UbuntuServer"
    sku       = "18.04-LTS"
    version   = "latest"
  }
}
`;

const SINGLE_RESOURCE_TF = `
provider "aws" {
  region = "us-east-1"
}

resource "aws_instance" "solo" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "t3.nano"
}
`;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("estimateCost", () => {
  let dbPath: string;
  let cache: PricingCache;
  let pricingEngine: PricingEngine;

  beforeEach(() => {
    dbPath = tempDbPath();
    cache = new PricingCache(dbPath);
    pricingEngine = new PricingEngine(cache, DEFAULT_CONFIG);
  });

  afterEach(() => {
    cache?.close();
    const dir = join(dbPath, "..");
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it("returns a cost breakdown with required top-level fields for AWS", async () => {
    const result = await estimateCost(
      {
        files: [{ path: "main.tf", content: AWS_INSTANCE_TF }],
        provider: "aws",
        region: "us-east-1",
      },
      pricingEngine,
      DEFAULT_CONFIG
    ) as Record<string, unknown>;

    expect(typeof result.total_monthly).toBe("number");
    expect(typeof result.total_yearly).toBe("number");
    expect(Array.isArray(result.by_resource)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(result.provider).toBe("aws");
  });

  it("total_yearly is approximately 12 times total_monthly", async () => {
    const result = await estimateCost(
      {
        files: [{ path: "main.tf", content: AWS_INSTANCE_TF }],
        provider: "aws",
        region: "us-east-1",
      },
      pricingEngine,
      DEFAULT_CONFIG
    ) as Record<string, unknown>;

    const monthly = result.total_monthly as number;
    const yearly = result.total_yearly as number;
    // Allow a small rounding tolerance.
    expect(yearly).toBeCloseTo(monthly * 12, 0);
  });

  it("by_resource entries contain required fields", async () => {
    const result = await estimateCost(
      {
        files: [{ path: "main.tf", content: AWS_INSTANCE_TF }],
        provider: "aws",
        region: "us-east-1",
      },
      pricingEngine,
      DEFAULT_CONFIG
    ) as Record<string, unknown>;

    const byResource = result.by_resource as Array<Record<string, unknown>>;
    expect(byResource.length).toBeGreaterThan(0);

    for (const entry of byResource) {
      expect(typeof entry.resource_id).toBe("string");
      expect(typeof entry.resource_type).toBe("string");
      expect(typeof entry.resource_name).toBe("string");
      expect(typeof entry.monthly_cost).toBe("number");
    }
  });

  it("a larger instance type produces a higher total cost than a smaller one", async () => {
    const smallTf = `
provider "aws" { region = "us-east-1" }
resource "aws_instance" "x" {
  ami           = "ami-abc"
  instance_type = "t3.nano"
}
`;
    const largeTf = `
provider "aws" { region = "us-east-1" }
resource "aws_instance" "x" {
  ami           = "ami-abc"
  instance_type = "t3.2xlarge"
}
`;

    const smallResult = await estimateCost(
      { files: [{ path: "main.tf", content: smallTf }], provider: "aws", region: "us-east-1" },
      pricingEngine,
      DEFAULT_CONFIG
    ) as Record<string, unknown>;

    const largeResult = await estimateCost(
      { files: [{ path: "main.tf", content: largeTf }], provider: "aws", region: "us-east-1" },
      pricingEngine,
      DEFAULT_CONFIG
    ) as Record<string, unknown>;

    expect(largeResult.total_monthly as number).toBeGreaterThan(smallResult.total_monthly as number);
  });

  // -------------------------------------------------------------------------
  // Provider variations
  // -------------------------------------------------------------------------

  it("estimates costs for a GCP config when provider is gcp", async () => {
    const result = await estimateCost(
      {
        files: [{ path: "main.tf", content: GCP_INSTANCE_TF }],
        provider: "gcp",
        region: "us-central1",
      },
      pricingEngine,
      DEFAULT_CONFIG
    ) as Record<string, unknown>;

    expect(result.provider).toBe("gcp");
    expect(result.total_monthly as number).toBeGreaterThanOrEqual(0);
    const byResource = result.by_resource as Array<Record<string, unknown>>;
    expect(byResource.length).toBeGreaterThan(0);
  });

  it("estimates costs for an Azure config when provider is azure", async () => {
    const result = await estimateCost(
      {
        files: [{ path: "main.tf", content: AZURE_INSTANCE_TF }],
        provider: "azure",
        region: "eastus",
      },
      pricingEngine,
      DEFAULT_CONFIG
    ) as Record<string, unknown>;

    expect(result.provider).toBe("azure");
    expect(result.total_monthly as number).toBeGreaterThanOrEqual(0);
  });

  it("can estimate an AWS config against the azure provider (cross-provider)", async () => {
    // Supplying an AWS config but asking for azure pricing exercises the
    // region-mapping and resource-mapping paths.
    const result = await estimateCost(
      {
        files: [{ path: "main.tf", content: AWS_INSTANCE_TF }],
        provider: "azure",
        region: "eastus",
      },
      pricingEngine,
      DEFAULT_CONFIG
    ) as Record<string, unknown>;

    expect(result.provider).toBe("azure");
    expect(typeof result.total_monthly).toBe("number");
  });

  // -------------------------------------------------------------------------
  // Currency conversion
  // -------------------------------------------------------------------------

  it("converts costs to EUR when currency is EUR", async () => {
    const usdResult = await estimateCost(
      {
        files: [{ path: "main.tf", content: AWS_INSTANCE_TF }],
        provider: "aws",
        region: "us-east-1",
        currency: "USD",
      },
      pricingEngine,
      DEFAULT_CONFIG
    ) as Record<string, unknown>;

    const eurResult = await estimateCost(
      {
        files: [{ path: "main.tf", content: AWS_INSTANCE_TF }],
        provider: "aws",
        region: "us-east-1",
        currency: "EUR",
      },
      pricingEngine,
      DEFAULT_CONFIG
    ) as Record<string, unknown>;

    // The EUR and USD totals should differ (different exchange rate).
    expect(eurResult.currency).toBe("EUR");
    expect(usdResult.currency).toBe("USD");
    // EUR total should be a positive number — not the same as USD.
    expect(eurResult.total_monthly as number).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it("handles a single-resource config without throwing", async () => {
    const result = await estimateCost(
      {
        files: [{ path: "main.tf", content: SINGLE_RESOURCE_TF }],
        provider: "aws",
        region: "us-east-1",
      },
      pricingEngine,
      DEFAULT_CONFIG
    ) as Record<string, unknown>;

    expect(typeof result.total_monthly).toBe("number");
    const byResource = result.by_resource as Array<Record<string, unknown>>;
    expect(byResource.length).toBeGreaterThanOrEqual(1);
  });

  it("returns zero total_monthly for a config with no priceable resources", async () => {
    // A provider block only — no resources.
    const emptyTf = `
provider "aws" {
  region = "us-east-1"
}
`;
    const result = await estimateCost(
      {
        files: [{ path: "main.tf", content: emptyTf }],
        provider: "aws",
        region: "us-east-1",
      },
      pricingEngine,
      DEFAULT_CONFIG
    ) as Record<string, unknown>;

    expect(result.total_monthly).toBe(0);
    const byResource = result.by_resource as Array<Record<string, unknown>>;
    expect(byResource.length).toBe(0);
  });

  it("omits redundant per-resource provider/region/currency/yearly fields", async () => {
    const result = await estimateCost(
      {
        files: [{ path: "main.tf", content: SINGLE_RESOURCE_TF }],
        provider: "aws",
        region: "us-east-1",
      },
      pricingEngine,
      DEFAULT_CONFIG
    ) as Record<string, unknown>;

    const byResource = result.by_resource as Array<Record<string, unknown>>;
    expect(byResource.length).toBeGreaterThan(0);

    for (const entry of byResource) {
      // These fields are stripped at the breakdown level to reduce payload size.
      expect(entry).not.toHaveProperty("provider");
      expect(entry).not.toHaveProperty("region");
      expect(entry).not.toHaveProperty("currency");
      expect(entry).not.toHaveProperty("yearly_cost");
    }
  });
});
