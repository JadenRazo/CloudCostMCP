provider "aws" {
  region = "us-east-1"
}

resource "aws_instance" "web" {
  count         = 3
  ami           = "ami-12345"
  instance_type = "t3.micro"

  tags = {
    Name = "web-${count.index}"
  }
}

resource "aws_sqs_queue" "queues" {
  for_each = toset(["orders", "notifications", "analytics"])
  name     = each.key
}

resource "aws_lambda_function" "handler" {
  function_name = "my-handler"
  runtime       = "nodejs20.x"
  handler       = "index.handler"
  memory_size   = 256
  timeout       = 30
  filename      = "lambda.zip"
}

module "vpc" {
  source = "terraform-aws-modules/vpc/aws"
  version = "5.0.0"

  name = "my-vpc"
  cidr = "10.0.0.0/16"
}
