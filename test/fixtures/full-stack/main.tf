provider "aws" {
  region = var.region
}

resource "aws_instance" "app" {
  ami           = var.ami_id
  instance_type = var.instance_type

  root_block_device {
    volume_size = var.volume_size
    volume_type = "gp3"
  }

  tags = {
    Name = "app-server"
  }
}

resource "aws_db_instance" "main" {
  identifier        = "main-db"
  engine            = "postgres"
  engine_version    = "15.4"
  instance_class    = "db.t3.medium"
  allocated_storage = 100
  multi_az          = true
  storage_type      = "gp3"

  tags = {
    Name = "main-database"
  }
}

resource "aws_s3_bucket" "assets" {
  bucket = "my-app-assets"

  tags = {
    Name = "assets-bucket"
  }
}

resource "aws_lb" "main" {
  name               = "main-lb"
  load_balancer_type = "application"
  internal           = false

  tags = {
    Name = "main-load-balancer"
  }
}

resource "aws_nat_gateway" "main" {
  allocation_id = "eip-12345"
  subnet_id     = "subnet-12345"

  tags = {
    Name = "main-nat-gateway"
  }
}
