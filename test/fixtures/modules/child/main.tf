resource "aws_instance" "child_server" {
  ami           = var.ami
  instance_type = var.instance_type

  tags = {
    Name = "child-server"
    Role = "worker"
  }
}

resource "aws_s3_bucket" "child_storage" {
  bucket = "child-module-storage"

  tags = {
    Name = "child-storage"
  }
}
