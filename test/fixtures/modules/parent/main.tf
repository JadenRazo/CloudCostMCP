provider "aws" {
  region = "us-east-1"
}

resource "aws_instance" "parent_server" {
  ami           = "ami-parent123"
  instance_type = "t3.medium"

  tags = {
    Name        = "parent-server"
    Environment = var.environment
  }
}

module "app" {
  source        = "../child"
  instance_type = var.child_instance_type
}
