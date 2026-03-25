variable "region" {
  default = "us-east-1"
}

variable "ami_id" {
  default = "ami-0c55b159cbfafe1f0"
}

variable "instance_type" {
  default = "t3.large"
}

variable "volume_size" {
  type    = number
  default = 50
}
