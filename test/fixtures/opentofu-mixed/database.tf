resource "aws_db_instance" "primary" {
  instance_class    = "db.t3.medium"
  engine            = "postgres"
  engine_version    = "15.4"
  allocated_storage = 50
  storage_type      = "gp2"
  multi_az          = true

  tags = {
    Name = "primary-db"
  }
}
